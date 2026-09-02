/**
 * The durable job-store seam (`ctx.jobStore`): an abstract {@link JobStore}
 * Definition plus {@link DomainJobStore}, the provider over the storage
 * domain data form. The registry (`@deepseek-ai/dsh-jobs-local`) writes
 * records here fire-and-forget; boot reconciliation reads them back to resume
 * or honestly settle work that outlived its host process.
 * @module @deepseek-ai/dsh-jobs-store-domain
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs/incarnation'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createJobsDomainSpec } from './spec.ts'
import type { JobRecord, JobsDomainSpec } from './spec.ts'

export {
  JOBS_DOMAIN_VERSION, createJobsDomainSpec, jobRecordSchema, jobsDomainSpec, jobsDomainState,
} from './spec.ts'
export type { JobRecord, JobsDomainSpec, JobsDomainState } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobStore: JobStore
  }
}

/**
 * Abstract durable job store. Subclass, implement the abstract members, and
 * load the subclass as a plugin — it registers as `ctx.jobStore` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Contract highlights for implementations:
 * - Reads are synchronous over authoritative in-memory state and reflect
 *   writes that are still queued (read-your-writes).
 * - {@link put} replaces the whole record (job records are monotone
 *   lifecycle snapshots, so last-write-wins per id is correct) and its
 *   returned promise settles with the durability of the latest queued value.
 * - A rejected write must reject the caller's promise; the caller — not the
 *   store — owns the degrade decision.
 */
export abstract class JobStore extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime: a composition row naming this seam alone
    // would register a ctx.jobStore with no method implementations and fail
    // far from the misconfiguration. Fail loud at load instead.
    if (new.target === JobStore) {
      throw new Error('@deepseek-ai/dsh-jobs-store-domain exports the abstract job-store seam as JobStore; load the DomainJobStore default export instead')
    }
    super(ctx, 'jobStore')
  }

  /** The process incarnation stamped into records this store writes (see `PROCESS_INCARNATION`). */
  abstract readonly incarnation: string

  /**
   * Snapshot every persisted record, including values still queued to write.
   * @returns fresh array of stored records in medium order with queued
   * overlays applied.
   */
  abstract list(): JobRecord[]

  /**
   * Read one record, including a value still queued to write.
   * @param id - record key.
   * @returns the record, or `undefined` when absent.
   */
  abstract get(id: JobId): JobRecord | undefined

  /**
   * Insert or replace one record durably. Writes may be coalesced per id;
   * the promise settles with the durability of the latest value queued for
   * that id and rejects when the medium refuses it.
   * @param record - the full new record (no partial merge).
   * @returns resolution after the write (or its coalesced successor) lands.
   */
  abstract put(record: JobRecord): Promise<void>

  /**
   * Delete one record durably, discarding any queued write for the same id
   * (the queued writers' promises resolve — their record was superseded by a
   * deliberate removal, not lost).
   * @param id - record key.
   * @returns `true` when a stored or queued record existed.
   */
  abstract delete(id: JobId): Promise<boolean>
}

/** Configures the domain-backed job store. */
export interface Config {
  /** Domain (and backend unit) name the store opens; omission defaults to 'jobs'. */
  domainName?: string
  /**
   * Per-id write coalescing window in milliseconds: rapid successive puts of
   * one record within the window land as a single durable write of the
   * latest value (default 200).
   */
  writeBatchMaxDelayMs?: number
}

export const Config: z<Config> = z.object({
  domainName: z.string().default('jobs'),
  writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(200),
})

/** One id's queued write: the latest value plus the shared settlement. */
interface PendingWrite {
  record: JobRecord
  timer: ReturnType<typeof setTimeout>
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * The domain-backed `ctx.jobStore`: one `records` table keyed by {@link JobId}
 * over `ctx.storageDomain`, with per-id write coalescing bounded by
 * `writeBatchMaxDelayMs`. Opening stamps the domain global with this
 * process's incarnation and boot time; a version-mismatched medium rejects at
 * open (fail loud at load, never a silent discard).
 */
export class DomainJobStore extends JobStore {
  static Config: z<Config> = Config
  static inject = ['storageDomain']

  /** The process incarnation stamped into records this store writes. */
  readonly incarnation: string = PROCESS_INCARNATION

  private readonly domainName: string
  private readonly writeBatchMaxDelayMs: number
  private table?: KvTable<JobId, JobRecord>
  private readonly pending = new Map<JobId, PendingWrite>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills defaults before constructing the service.
    const resolved = config as Required<Config>
    this.domainName = resolved.domainName
    this.writeBatchMaxDelayMs = resolved.writeBatchMaxDelayMs
  }

  /** Open the domain, record this boot in the global, and arm teardown. */
  protected async [Service.init](): Promise<void> {
    const domain: Domain<JobsDomainSpec> = await this.ctx.storageDomain.open(createJobsDomainSpec(this.domainName))
    this.ctx.effect(() => () => this.close(domain), 'jobStore.domainClose')
    this.table = domain.table('records')
    await domain.global.set({ incarnation: this.incarnation, bootedAt: Date.now() })
  }

  list(): JobRecord[] {
    const merged = new Map<JobId, JobRecord>(this.requireTable().entries())
    for (const [id, entry] of this.pending) merged.set(id, entry.record)
    return [...merged.values()]
  }

  get(id: JobId): JobRecord | undefined {
    return this.pending.get(id)?.record ?? this.requireTable().get(id)
  }

  put(record: JobRecord): Promise<void> {
    const existing = this.pending.get(record.id)
    if (existing !== undefined) {
      // Coalesce: the newer snapshot supersedes the queued one; both callers
      // share the settlement of the single durable write.
      existing.record = record
      return existing.promise
    }
    this.requireTable()
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    const timer = setTimeout(() => { this.flush(record.id) }, this.writeBatchMaxDelayMs)
    timer.unref()
    this.pending.set(record.id, { record, timer, promise, resolve, reject })
    return promise
  }

  async delete(id: JobId): Promise<boolean> {
    const table = this.requireTable()
    const entry = this.pending.get(id)
    if (entry !== undefined) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
    }
    try {
      const deleted = await table.delete(id)
      // A queued-but-never-landed record was deliberately removed: its
      // writers' durability promise resolves rather than dangling forever.
      entry?.resolve()
      return deleted || entry !== undefined
    } catch (error) {
      entry?.reject(error)
      throw error
    }
  }

  /** Land one id's queued write on the domain's write chain. */
  private flush(id: JobId): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    this.requireTable().put(id, entry.record).then(entry.resolve, entry.reject)
  }

  /** Flush every queued write, then close the domain. */
  private async close(domain: Domain<JobsDomainSpec>): Promise<void> {
    const flushed = [...this.pending.values()].map(entry => entry.promise.catch(() => {
      // The write's owner observes the rejection through its own put()
      // promise; teardown only waits for the chain to drain.
    }))
    for (const id of [...this.pending.keys()]) this.flush(id)
    await Promise.all(flushed)
    await domain.close()
  }

  /** The open records table, or fail loud before init completed. */
  private requireTable(): KvTable<JobId, JobRecord> {
    if (this.table === undefined) {
      throw new Error('jobStore is not initialized: the jobs domain has not been opened yet')
    }
    return this.table
  }
}

export default DomainJobStore

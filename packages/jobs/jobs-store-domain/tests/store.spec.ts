import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs/incarnation'
import DomainJobStore, {
  Config, JOBS_DOMAIN_VERSION, JobStore, createJobsDomainSpec, jobRecordSchema, jobsDomainSpec, jobsDomainState,
} from '../src/index.ts'
import type { JobRecord } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** One complete durable record. */
function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: JobId('bash-11111111-2222-4333-8444-555555555555'),
    kind: 'bash',
    label: 'sleep 60',
    ownerSession: null,
    status: 'running',
    detail: null,
    output: null,
    startedAt: 100,
    finishedAt: null,
    reported: false,
    outputLimitBytes: null,
    resumeSpec: null,
    incarnation: 'proc-1',
    schemaVersion: 1,
    ...overrides,
  }
}

/** Boot the storage hub, a memory backend, the domain facility, and the store. */
async function harness(options: { pool?: MemoryMediaPool; config?: Config } = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(DomainJobStore, options.config ?? {})
  return { ctx, pool, fiber }
}

describe('jobs domain spec', () => {
  it('declares the versioned layout and validates records at the durable boundary', () => {
    expect(JOBS_DOMAIN_VERSION).toBe(1)
    expect(jobsDomainSpec.name).toBe('jobs')
    expect(jobsDomainSpec.version).toBe(JOBS_DOMAIN_VERSION)
    expect(createJobsDomainSpec('jobs_alt').name).toBe('jobs_alt')

    expect(jobRecordSchema.parse(record())).toMatchObject({ kind: 'bash', schemaVersion: 1 })
    expect(() => jobRecordSchema.parse(record({ status: 'pending' as JobRecord['status'] }))).toThrow()
    expect(() => jobRecordSchema.parse({ ...record(), schemaVersion: 2 })).toThrow()
    expect(jobsDomainState.parse({ incarnation: 'p', bootedAt: 5 })).toEqual({ incarnation: 'p', bootedAt: 5 })
  })
})

describe('DomainJobStore lifecycle', () => {
  it('registers as ctx.jobStore, stamps the boot global, and round-trips records across reopen', async () => {
    const pool = new MemoryMediaPool()
    {
      const { ctx, fiber } = await harness({ pool })
      expect(ctx.jobStore).toBeInstanceOf(DomainJobStore)
      expect(ctx.jobStore.incarnation).toBe(PROCESS_INCARNATION)
      const global = pool.media.get('jobs')?.global as { incarnation: string; bootedAt: number }
      expect(global.incarnation).toBe(PROCESS_INCARNATION)
      expect(global.bootedAt).toBeTypeOf('number')

      await ctx.jobStore.put(record())
      expect(ctx.jobStore.get(record().id)).toMatchObject({ label: 'sleep 60' })
      await fiber.dispose()
    }
    const { ctx } = await harness({ pool })
    expect(ctx.jobStore.list()).toHaveLength(1)
    expect(ctx.jobStore.get(record().id)).toMatchObject({ kind: 'bash', incarnation: 'proc-1' })
  })

  it('mounting the abstract seam directly fails loudly at load (stale-composition fence)', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(JobStore as unknown as typeof DomainJobStore))
      .rejects.toThrow(/abstract job-store seam/)
  })

  it('rejects a version-mismatched medium at open instead of discarding records', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('jobs', JOBS_DOMAIN_VERSION + 1)
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await expect(ctx.plugin(DomainJobStore, {})).rejects.toMatchObject({ code: 'version-mismatch' })
  })

  it('surfaces an invalid stored record with its table and key', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('jobs', JOBS_DOMAIN_VERSION)
    pool.media.set('jobs', {
      tables: new Map([['records', new Map([['bash-x', { nonsense: true }]])]]),
      global: null,
    })
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await expect(ctx.plugin(DomainJobStore, {})).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'records', key: 'bash-x' },
    })
  })

  it('opens under the configured domain name and fails loud on an invalid one', async () => {
    const { pool } = await harness({ config: { domainName: 'jobs_alt' } })
    expect(pool.media.has('jobs_alt')).toBe(true)

    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await expect(ctx.plugin(DomainJobStore, { domainName: 'Not A Unit Name' })).rejects.toThrow(/must match/)
  })

  it('rejects an invalid write-batch window and defaults the config', () => {
    const resolved = Config({})
    expect(resolved.domainName).toBe('jobs')
    expect(resolved.writeBatchMaxDelayMs).toBe(200)
    expect(() => Config({ writeBatchMaxDelayMs: 0 })).toThrow()
    expect(() => Config({ writeBatchMaxDelayMs: 2_147_483_648 })).toThrow()
  })

  it('fails loud when used before the domain opened', () => {
    const store = new DomainJobStore(new Context(), Config({}))
    expect(() => store.list()).toThrow('jobStore is not initialized')
  })
})

describe('DomainJobStore writes', () => {
  it('coalesces rapid puts of one id into a single durable write of the latest value', async () => {
    const { ctx, pool } = await harness({ config: { writeBatchMaxDelayMs: 5 } })
    const first = record()
    const latest = record({ status: 'completed', finishedAt: 200 })
    const settledFirst = ctx.jobStore.put(first)
    const settledLatest = ctx.jobStore.put(latest)
    // One queued write per id: both callers share its settlement.
    expect(settledFirst).toBe(settledLatest)
    // Read-your-writes before the flush lands.
    expect(ctx.jobStore.get(first.id)).toMatchObject({ status: 'completed' })
    expect(ctx.jobStore.list()).toHaveLength(1)
    expect(pool.media.get('jobs')?.tables.get('records')?.size ?? 0).toBe(0)

    await settledFirst
    expect(pool.media.get('jobs')?.tables.get('records')?.get(String(first.id))).toMatchObject({ status: 'completed' })
  })

  it('delete discards a queued-only record, resolving its writers', async () => {
    const { ctx, pool } = await harness({ config: { writeBatchMaxDelayMs: 60_000 } })
    const queued = ctx.jobStore.put(record())
    await expect(ctx.jobStore.delete(record().id)).resolves.toBe(true)
    await expect(queued).resolves.toBeUndefined()
    expect(ctx.jobStore.get(record().id)).toBeUndefined()
    expect(pool.media.get('jobs')?.tables.get('records')?.size ?? 0).toBe(0)
    // Deleting an id that never existed anywhere reports false.
    await expect(ctx.jobStore.delete(JobId('bash-none'))).resolves.toBe(false)
  })

  it('a rejected flush rejects the callers put promise', async () => {
    const { ctx, pool } = await harness({ config: { writeBatchMaxDelayMs: 5 } })
    pool.failNextWrites = 1
    await expect(ctx.jobStore.put(record())).rejects.toThrow('injected write failure')
  })

  it('a rejected durable delete rejects the caller and any queued writers', async () => {
    const { ctx, pool } = await harness({ config: { writeBatchMaxDelayMs: 5 } })
    const seeded = record()
    // Land the seed durably so the delete reaches the failing primitive.
    await ctx.jobStore.put(seeded)

    const queued = ctx.jobStore.put(record({ status: 'stopping' }))
    pool.failNextWrites = 1
    await expect(ctx.jobStore.delete(seeded.id)).rejects.toThrow('injected write failure')
    await expect(queued).rejects.toThrow('injected write failure')
  })

  it('close flushes queued writes before releasing the domain', async () => {
    const pool = new MemoryMediaPool()
    const { ctx, fiber } = await harness({ pool, config: { writeBatchMaxDelayMs: 60_000 } })
    const landed = ctx.jobStore.put(record())
    await fiber.dispose()
    await expect(landed).resolves.toBeUndefined()
    expect(pool.media.get('jobs')?.tables.get('records')?.size).toBe(1)
  })

  it('close still completes when a queued flush fails, leaving the rejection to its writer', async () => {
    const pool = new MemoryMediaPool()
    const { ctx, fiber } = await harness({ pool, config: { writeBatchMaxDelayMs: 60_000 } })
    const failing = ctx.jobStore.put(record())
    pool.failNextWrites = 1
    await fiber.dispose()
    await expect(failing).rejects.toThrow('injected write failure')
  })

  it('a flush of an unknown id is a no-op', async () => {
    const { ctx } = await harness()
    const internal = ctx.jobStore as unknown as { flush(id: string): void }
    expect(() => { internal.flush('bash-unknown') }).not.toThrow()
  })
})

/**
 * One opened JSON unit. The in-memory state is authoritative; every write
 * primitive mutates it and republishes the whole file atomically. Writes are
 * NOT queued here — per the backend contract, write ordering belongs to the
 * caller (the domain layer's write chain); this unit only guarantees that
 * each single call publishes a complete, durable file.
 *
 * Publishes are coalesced, never reordered: while one publish is in flight,
 * further commits mutate memory and wait, and one follow-up publish of the
 * final state settles all of them, so a burst of N overlapping commits costs
 * two whole-file writes instead of N. Each awaited call still resolves only
 * after a durable publish that includes the state it requested, and a publish
 * whose bytes match the last one this unit published is skipped: the medium
 * already holds that exact file.
 * @module @deepseek-ai/dsh-storage-json/src/unit
 */

import { readFile } from 'node:fs/promises'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { FormatPolicy, UnitState } from './format.ts'

/**
 * Open (load or lazily create) one unit backed by `path`.
 * @param descriptor - Static identity and shape of the unit.
 * @param path - Absolute unit file path under the backend root.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @param format - Formatting policy for every file this unit publishes.
 * @returns the opened unit.
 */
export async function openJsonUnit(
  descriptor: KvUnitDescriptor,
  path: string,
  onClose: () => void,
  format: FormatPolicy,
): Promise<KvUnit> {
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing file = empty unit; materialization defers to the first write.
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new JsonKvUnit(descriptor, path, state, onClose, format)
}

/** One caller waiting for a publish that covers its own mutation. */
interface PublishWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

class JsonKvUnit implements KvUnit {
  private closed = false
  /** Undo callbacks for mutations no publish has committed yet, oldest first. */
  private readonly uncommitted: (() => void)[] = []
  /** Callers whose mutation still needs a publish, oldest first. */
  private readonly waiting: PublishWaiter[] = []
  /** Set by every commit; cleared when a publish takes the current state. */
  private dirty = false
  /** The running publisher loop; close() drains it before releasing the unit. */
  private publishing: Promise<void> | undefined
  /** Bytes this unit last published; an identical serialization needs no write. */
  private published: string | undefined

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
    private readonly format: FormatPolicy,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async keeps the closed guard a rejection, not a synchronous throw
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    await this.commit(() => {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    await this.commit(() => records.set(key, previous))
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = value
    await this.commit(() => {
      this.state.global = previous
    })
  }

  async close(): Promise<void> {
    const wasOpen = !this.closed
    this.closed = true
    await this.publishing
    if (wasOpen) this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  /**
   * Register one already-applied mutation with the publisher. The caller's
   * promise settles with the first publish that serializes state including
   * this mutation; `undo` restores memory if that publish fails.
   */
  private commit(undo: () => void): Promise<void> {
    this.uncommitted.push(undo)
    this.dirty = true
    const settled = new Promise<void>((resolve, reject) => {
      this.waiting.push({ resolve, reject })
    })
    this.publishing ??= this.runPublisher()
    return settled
  }

  /**
   * Publish the current state until nothing is dirty. Each iteration takes
   * every waiter registered so far, so commits that arrive while a write is
   * in flight are settled together by the next iteration rather than by a
   * write of their own. The loop never rejects: failures settle through the
   * waiters it took.
   */
  private async runPublisher(): Promise<void> {
    // One yield before any work: `commit` records this promise synchronously
    // after the call returns, and a publish that skips the write finishes
    // without awaiting anything — the yield keeps the field's clear from
    // landing before its assignment.
    await Promise.resolve()
    try {
      while (this.dirty) {
        this.dirty = false
        const batch = this.waiting.splice(0)
        const undos = this.uncommitted.splice(0)
        try {
          const text = serialize(this.descriptor.name, this.state, this.format)
          if (text !== this.published) {
            await writeAtomic(this.path, text)
            this.published = text
          }
          for (const waiter of batch) waiter.resolve()
        } catch (error) {
          // Memory is authoritative, so a failed publish must leave nothing
          // uncommitted behind — neither in memory nor riding along with the
          // next publish. Everything applied since the last durable file is
          // undone newest-first and every waiter it belongs to rejects.
          const queued = this.waiting.splice(0)
          for (const undo of [...undos, ...this.uncommitted.splice(0)].reverse()) undo()
          this.dirty = false
          for (const waiter of [...batch, ...queued]) waiter.reject(error)
        }
      }
    } finally {
      // No await separates the loop's exit from this line, so a commit either
      // set `dirty` in time for the loop to see it or starts a fresh loop.
      this.publishing = undefined
    }
  }
}

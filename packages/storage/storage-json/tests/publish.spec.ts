import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'
import type { FormatPolicy } from '../src/index.ts'
import { parse, serialize } from '../src/format.ts'
import type { UnitState } from '../src/format.ts'

/** Physical publishes: writeAtomic finishes every one with exactly one rename. */
const publishes = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    rename: async (from: string, to: string) => {
      publishes.count += 1
      await actual.rename(from, to)
    },
  }
})

const PRETTY: FormatPolicy = { prettyPrintMaxBytes: Number.MAX_SAFE_INTEGER }
const COMPACT: FormatPolicy = { prettyPrintMaxBytes: 0 }
const DESCRIPTOR = { name: 'burst', version: 1, tables: ['t'], hasGlobal: true }

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-publish-'))
  roots.push(root)
  return root
}

async function openUnit(format: FormatPolicy) {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root, format)
  return { backend, root, path: join(root, 'burst.json'), unit: await backend.kv.open(DESCRIPTOR) }
}

async function readTables(path: string): Promise<Record<string, Record<string, unknown>>> {
  return (JSON.parse(await readFile(path, 'utf8')) as { tables: Record<string, Record<string, unknown>> }).tables
}

beforeEach(() => {
  publishes.count = 0
})

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('publish coalescing', () => {
  it('publishes one file for a burst of commits issued without an intervening await', async () => {
    const { backend, unit, path } = await openUnit(PRETTY)
    await Promise.all(Array.from({ length: 10 }, (_, i) => unit.putRecord('t', `k${i}`, { n: i })))
    expect(publishes.count).toBe(1)
    expect(Object.keys((await readTables(path))['t']!)).toHaveLength(10)
    await backend.close()
  })

  it('settles commits made during a publish with one follow-up publish', async () => {
    const { backend, unit, path } = await openUnit(PRETTY)
    const first = unit.putRecord('t', 'first', { n: 0 })
    await new Promise(resolve => setImmediate(resolve))
    const rest = Array.from({ length: 9 }, (_, i) => unit.putRecord('t', `k${i}`, { n: i }))
    await Promise.all([first, ...rest])
    expect(publishes.count).toBe(2)
    expect(Object.keys((await readTables(path))['t']!)).toHaveLength(10)
    await backend.close()
  })

  it('resolves each awaited write only once the file holds that write', async () => {
    const { backend, unit, path } = await openUnit(PRETTY)
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      await unit.putRecord('t', `k${i}`, { n: i })
      expect((await readTables(path))['t']![`k${i}`]).toEqual({ n: i })
    }))
    await backend.close()
  })

  it('skips a publish whose bytes match the file already on the medium', async () => {
    const { backend, unit, path } = await openUnit(PRETTY)
    await unit.putRecord('t', 'k', { v: 1 })
    expect(publishes.count).toBe(1)
    await unit.putRecord('t', 'k', { v: 1 })
    await unit.deleteRecord('t', 'absent')
    expect(publishes.count).toBe(1)
    await unit.putRecord('t', 'k', { v: 2 })
    expect(publishes.count).toBe(2)
    expect((await readTables(path))['t']!['k']).toEqual({ v: 2 })
    await backend.close()
  })

  it('publishes through temp file and rename, leaving no residue after a burst', async () => {
    const { backend, unit, root } = await openUnit(PRETTY)
    await Promise.all(Array.from({ length: 5 }, (_, i) => unit.putRecord('t', `k${i}`, { n: i })))
    await backend.close()
    expect(await readdir(root)).toEqual(['burst.json'])

    const reopened = new JsonStorageBackend(root, PRETTY)
    const unit2 = await reopened.kv.open(DESCRIPTOR)
    expect(Object.keys((await unit2.loadAll()).tables['t']!)).toHaveLength(5)
    await reopened.close()
  })

  it('rolls back every uncommitted mutation when a coalesced publish fails', async () => {
    const { backend, unit, root, path } = await openUnit(PRETTY)
    await unit.putRecord('t', 'k', { v: 'committed' })
    const backup = join(root, 'committed.json')
    // A directory at the publish target rejects atomic replacement on every host.
    const { rename } = await import('node:fs/promises')
    await rename(path, backup)
    await mkdir(path)

    const failing = [
      unit.putRecord('t', 'k', { v: 'rejected' }),
      unit.putRecord('t', 'queued', { v: 'also rejected' }),
      unit.deleteRecord('t', 'k'),
    ]
    for (const write of failing) await expect(write).rejects.toThrow()
    expect((await unit.loadAll()).tables['t']).toEqual({ k: { v: 'committed' } })

    await rm(path, { recursive: true })
    await rename(backup, path)
    await unit.putRecord('t', 'later', { v: 'later' })
    expect(await readFile(path, 'utf8')).not.toContain('rejected')
    await backend.close()
  })
})

describe('publish formatting', () => {
  it('publishes compact past the ceiling and pretty below it', async () => {
    const row = { blob: 'x'.repeat(64), nested: { a: 1, b: [1, 2, 3] } }
    const small = await openUnit({ prettyPrintMaxBytes: 1024 * 1024 })
    await small.unit.putRecord('t', 'k', row)
    const pretty = await readFile(small.path, 'utf8')
    await small.backend.close()

    const large = await openUnit(COMPACT)
    await large.unit.putRecord('t', 'k', row)
    const compact = await readFile(large.path, 'utf8')
    await large.backend.close()

    expect(pretty).toContain('\n  "unit": {')
    expect(compact.trimEnd()).not.toContain('\n')
    expect(compact.length).toBeLessThan(pretty.length * 0.7)
  })

  it('reopens a compact file with the same state a pretty file gives', async () => {
    const compact = await openUnit(COMPACT)
    await compact.unit.putRecord('t', 'k', { v: [1, { deep: 'value' }] })
    await compact.unit.setGlobal({ g: 'set' })
    await compact.backend.close()

    const reopened = new JsonStorageBackend(compact.root, COMPACT)
    const unit = await reopened.kv.open(DESCRIPTOR)
    expect(await unit.loadAll()).toEqual({ tables: { t: { k: { v: [1, { deep: 'value' }] } } }, global: { g: 'set' } })
    await reopened.close()
  })

  it('round-trips both formatting modes through parse() to the same state', () => {
    const state: UnitState = {
      version: 1,
      global: { on: true },
      tables: new Map([['t', new Map<string, unknown>([['a', { n: 1 }], ['b', { s: 'héllo', list: [1, 2] }]])]]),
    }
    const pretty = serialize('burst', state, PRETTY)
    const compact = serialize('burst', state, COMPACT)
    expect(pretty).not.toBe(compact)
    expect(parse(pretty, DESCRIPTOR)).toEqual(state)
    expect(parse(compact, DESCRIPTOR)).toEqual(state)
    expect(pretty.endsWith('\n')).toBe(true)
    expect(compact.endsWith('\n')).toBe(true)
  })
})

import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import JsonlSessionPersistence from '../src/index.ts'
import { logPath } from '../src/format.ts'

interface MetadataInternals {
  readGenerationHeader(...args: unknown[]): Promise<unknown>
  readStableHeader(...args: unknown[]): Promise<SessionPersistenceSnapshot | undefined>
  findOppositeGenerationInDirectory(dir: string): Promise<string | undefined>
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-metadata-reconciliation-'))
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', listConcurrency: 2 })
  const headers = Array.from({ length: 6 }, (_, index): SessionHeader => ({
    version: SESSION_FORMAT_VERSION, id: SessionId(`metadata-${index}`),
    createdAt: index + 1, isSeeded: false, cwd: '/workspace',
  }))
  for (const header of headers) {
    const handle = await ctx.sessionPersistence.create(header)
    try {
      await handle.flush()
    } finally {
      await handle.close()
    }
  }
  return { root, ctx, headers }
}

describe('V3 metadata reconciliation', () => {
  it('pairs stat metadata with one stable physical revision when an append races the header read', async () => {
    const { root, ctx, headers } = await fixture()
    try {
      const header = headers[0]!
      const backend = ctx.sessionPersistence as unknown as MetadataInternals
      const original = backend.readGenerationHeader.bind(backend)
      let changed = false
      const probe = vi.spyOn(backend, 'readGenerationHeader').mockImplementation(async (...args) => {
        const result = await original(...args)
        if (!changed) {
          changed = true
          await appendFile(logPath(root, header.cwd, header.id, 'none'), JSON.stringify({
            type: 'turn/start', seq: 0, time: 10, data: { turn: 1 },
          }) + '\n')
        }
        return result
      })
      const snapshot = await ctx.sessionPersistence.stat(header.id)
      expect(probe).toHaveBeenCalledTimes(2)
      probe.mockRestore()
      expect(snapshot).toEqual((await ctx.sessionPersistence.list()).find(item => item.header.id === header.id))
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('bounds simultaneous generation/header probes and preserves all rows', async () => {
    const { root, ctx } = await fixture()
    try {
      const backend = ctx.sessionPersistence as unknown as MetadataInternals
      const original = backend.readStableHeader.bind(backend)
      let active = 0
      let maximum = 0
      vi.spyOn(backend, 'readStableHeader').mockImplementation(async (...args) => {
        active++
        maximum = Math.max(maximum, active)
        try {
          await new Promise<void>(resolve => setImmediate(resolve))
          return await original(...args)
        } finally { active-- }
      })
      expect(await ctx.sessionPersistence.list()).toHaveLength(6)
      expect(maximum).toBe(2)
      expect(active).toBe(0)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('does not poison a later root check when the first caller cancels', async () => {
    const { root, ctx } = await fixture()
    const cold = new Context()
    try {
      await cold.plugin(JsonlSessionPersistence, { root, compression: 'none', listConcurrency: 2 })
      const backend = cold.sessionPersistence as unknown as MetadataInternals
      const original = backend.findOppositeGenerationInDirectory.bind(backend)
      const controller = new AbortController()
      const reason = new Error('cancel root metadata read')
      const probe = vi.spyOn(backend, 'findOppositeGenerationInDirectory').mockImplementation(async (dir) => {
        controller.abort(reason)
        return original(dir)
      })
      await expect(cold.sessionPersistence.list({ signal: controller.signal })).rejects.toBe(reason)
      probe.mockRestore()
      expect(await cold.sessionPersistence.list()).toHaveLength(6)
    } finally {
      await cold.fiber.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

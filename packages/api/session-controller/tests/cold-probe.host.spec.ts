import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

/** Physical size belongs to persistence metadata, never a provider-specific path. */
describe('cold blankness probes through V3 metadata', () => {
  it.each([0, 1024, 1025, undefined])('bounds body observations for an artifact of %s bytes', async (sizeBytes) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId('blank-probe'),
      createdAt: 1, isSeeded: false, cwd: '/workspace',
    }
    const inspect = vi.fn(async () => ({ meta: header, events: [] }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header],
      stat: async () => ({
        header, revision: SessionPersistenceRevision('probe'),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      }),
      inspect,
    }) as never)
    const remote = createSessionTestRemote(ctx, {
      cwd: '/workspace', defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    })
    vi.spyOn(ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValue([])
    try {
      const response = await remote.list({})
      if (!response.ok) throw response.error
      const eligible = sizeBytes !== undefined && sizeBytes <= 1024
      expect(response.value.items[0]?.blank).toBe(eligible)
      expect(inspect).toHaveBeenCalledTimes(eligible ? 1 : 0)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps a row visible when the metadata probe fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('failed-probe'), createdAt: 1, isSeeded: false, cwd: '/workspace' }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header], stat: async () => { throw new Error('offline') },
    }) as never)
    const remote = createSessionTestRemote(ctx, { cwd: '/workspace', defaultModelSelection: () => ({ provider: 'p', model: 'm' }) })
    vi.spyOn(ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValue([])
    try {
      const response = await remote.list({})
      if (!response.ok) throw response.error
      expect(response.value.items[0]).toMatchObject({ sessionId: header.id, blank: false })
    } finally { await ctx.fiber.dispose() }
  })
})

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ApiSessionList } from '../src/list.ts'
import { SessionControlController } from '../src/control.ts'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

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

  it('probes without a caller signal and keeps an unreadable body visible', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('unreadable-body'), createdAt: 1, isSeeded: false, cwd: '/workspace' }
    const failure = new Error('body unavailable')
    const inspect = vi.fn(async () => { throw failure })
    const stat = vi.fn(async () => ({ header, revision: SessionPersistenceRevision('unreadable'), sizeBytes: 1 }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header], stat, inspect,
    }) as never)
    installSessionReadTestServices(ctx)
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockResolvedValue([{ header, live: false, persisted: true }])
    vi.spyOn(ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValue([])
    const warn = vi.spyOn(ctx.logger, 'warn')
    const list = new ApiSessionList(ctx)
    try {
      await expect(list.list()).resolves.toEqual([expect.objectContaining({ sessionId: header.id, blank: false })])
      expect(stat).toHaveBeenCalledWith(header.id, undefined)
      expect(inspect).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('body unavailable'))
    } finally { await ctx.fiber.dispose() }
  })

  it('propagates cancellation while a cold body observation is pending', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('cancelled-body'), createdAt: 1, isSeeded: false, cwd: '/workspace' }
    const entered = Promise.withResolvers<undefined>()
    const body = Promise.withResolvers<never>()
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header],
      stat: async () => ({ header, revision: SessionPersistenceRevision('cancelled'), sizeBytes: 1 }),
      inspect: () => { entered.resolve(undefined); return body.promise },
    }) as never)
    installSessionReadTestServices(ctx)
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockResolvedValue([{ header, live: false, persisted: true }])
    const list = new ApiSessionList(ctx)
    const caller = new AbortController()
    const failure = new Error('caller cancelled')
    const pending = list.list(caller.signal)
    const rejected = expect(pending).rejects.toBe(failure)
    try {
      await entered.promise
      caller.abort(failure)
      body.reject(failure)
      await rejected
    } finally { body.reject(failure); await ctx.fiber.dispose() }
  })

  it('uses the live row when attachment wins the cold metadata probe', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const projections = ctx.plugin(SessionProjectionRegistry)
    await projections
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('attached-during-probe'), createdAt: 1, isSeeded: false, cwd: '/workspace' }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header],
      stat: async () => {
        ctx.sessions.create(header.id, { meta: { ...header, cwd: '/live' } })
        await projections.dispose()
        return { header, revision: SessionPersistenceRevision('attached'), sizeBytes: 1 }
      },
    }) as never)
    installSessionReadTestServices(ctx)
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockResolvedValue([{ header, live: false, persisted: true }])
    vi.spyOn(ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValue([])
    const list = new ApiSessionList(ctx)
    try {
      await expect(list.list()).resolves.toEqual([expect.objectContaining({ sessionId: header.id, cwd: '/live', blank: true })])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps a control baseline available after its projection service withdraws', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const projections = ctx.plugin(SessionProjectionRegistry)
    await projections
    const session = ctx.sessions.create(SessionId('withdrawn-projections'))
    const control = new SessionControlController(ctx)
    const signal = new AbortController()
    const stream = control.control(signal.signal)[Symbol.asyncIterator]()
    try {
      await projections.dispose()
      await expect(stream.next()).resolves.toMatchObject({
        value: { type: 'baseline', value: { projections: { [session.id]: { asOfSeq: session.seq - 1, values: {} } } } },
      })
    } finally { signal.abort(); await stream.return?.(); await ctx.fiber.dispose() }
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

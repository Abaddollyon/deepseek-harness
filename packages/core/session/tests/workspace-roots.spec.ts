import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { buildForkSeed, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

describe('Session additional roots', () => {
  it('records the roots once as the ignorable seq-0 event and restores them from the log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.prepare(SessionId('roots'), { meta: { cwd: '/work/app', additionalPaths: ['/work/lib', '/work/docs'] } })
    session.append('turn/start', { turn: 1 })

    const events = session.snapshotEvents()
    expect(events[0]).toMatchObject({ type: 'workspace/roots', seq: 0, ignorable: true, data: { additionalPaths: ['/work/lib', '/work/docs'] } })
    expect(session.firstLiveSeq).toBe(0)
    expect(session.header).not.toHaveProperty('additionalPaths')
    expect(session.additionalPaths).toEqual(['/work/lib', '/work/docs'])
    expect(() => session.append('workspace/roots', { additionalPaths: ['/elsewhere'] })).toThrow(/only when a Session is created/)

    const restored = Session.fromRestore(session.id, structuredClone([...events]), structuredClone(session.header), SessionLogOffset(0), 'detached')
    expect(restored.additionalPaths).toEqual(['/work/lib', '/work/docs'])
    expect(Session.create(SessionId('plain')).additionalPaths).toEqual([])
  })

  it('lets a fork inherit the roots and refuses a different list for the same seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parent = ctx.sessions.prepare(SessionId('parent'), { meta: { cwd: '/work/app', additionalPaths: ['/work/lib'] } })
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const seed = buildForkSeed(parent.snapshotEvents(), SessionSeq(2))
    const fork = (additionalPaths?: readonly string[]) => ctx.sessions.prepare(SessionId('child'), {
      seed,
      inheritedEventCount: SessionLogOffset(3),
      meta: { cwd: '/work/app', isSeeded: true, ...additionalPaths === undefined ? {} : { additionalPaths } },
    })

    expect(fork().additionalPaths).toEqual(['/work/lib'])
    expect(fork(['/work/lib']).additionalPaths).toEqual(['/work/lib'])
    expect(() => fork(['/work/other'])).toThrow(/must equal its seed/)
  })

  it('rejects a roots event anywhere but the ignorable seq-0 position', () => {
    const roots = (seq: number, additionalPaths = ['/work/lib']): SessionEvent<'workspace/roots'> => ({
      type: 'workspace/roots', seq: SessionSeq(seq), time: 1, data: { additionalPaths }, ignorable: true,
    })
    const { ignorable: _ignorable, ...required } = roots(0)
    const turn: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }

    expect(() => Session.create(SessionId('late'), [turn, roots(1)])).toThrow(/ignorable event at seq 0/)
    expect(() => Session.create(SessionId('required'), [required])).toThrow(/ignorable event at seq 0/)
    expect(() => Session.create(SessionId('relative'), [roots(0, ['lib'])])).toThrow(/unique absolute paths/)
    expect(() => Session.create(SessionId('fresh'), undefined, undefined, undefined, undefined, ['relative'])).toThrow(/unique absolute paths/)
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it } from 'vitest'

it('persists creation roots across a cold storage reopen without changing legacy Chats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-roundtrip-'))
  const ctx = new Context()
  const cold = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const rooted = ctx.sessions.create(SessionId('rooted'), { meta: { cwd: '/project', additionalPaths: ['/shared'] } })
    const chat = ctx.sessions.create(SessionId('legacy-chat'), { meta: { cwd: '/project' } })
    for (const session of [rooted, chat]) {
      const handle = await ctx.sessionPersistence.create(session.header)
      try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
    }
    await ctx.fiber.dispose()
    await cold.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    for (const [id, paths] of [[rooted.id, ['/shared']], [chat.id, []]] as const) {
      const reader = await cold.sessionPersistence.open(id, 'read')
      try {
        const read = await reader.read()
        const restored = Session.fromRestore(id, read.events, reader.header, SessionLogOffset(0), read.eventState)
        expect(restored.additionalPaths).toEqual(paths)
        expect(Object.isFrozen(restored.additionalPaths)).toBe(true)
        expect(reader.header).not.toHaveProperty('additionalPaths')
        expect(read.events[0]?.type).toBe(paths.length === 0 ? undefined : 'workspace/roots')
        expect(read.events[0]?.ignorable).toBeUndefined()
      } finally { await reader.close() }
    }
  } finally {
    await cold.fiber.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

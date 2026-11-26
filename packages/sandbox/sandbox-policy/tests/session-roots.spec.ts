/** A Session's recorded `workspace/roots` become writable grants for each Agent started on it. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function mounted() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-policy-session-roots-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const [app, lib, shared] = [join(base, 'app'), join(base, 'lib'), join(base, 'shared')]
  for (const directory of [app, lib, shared]) await mkdir(directory)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base, additionalWritableRoots: [shared] })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, base, app, lib, shared }
}

describe('recorded Session workspace roots', () => {
  it('grants them after the configured roots for the Agent\'s lifetime and lists them in workspace-write context', async () => {
    const { ctx, app, lib, shared } = await mounted()
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('multi-root'),
      meta: { cwd: app, additionalPaths: [lib] },
    })
    const session = handle.agent.session
    expect(session.additionalPaths).toEqual([lib])
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({
      mode: 'workspace-write', workspaceRoot: app, additionalWritableRoots: [shared, lib], sessionId: session.id,
    })
    const context = (await ctx.systemPrompt.assemble({ agent: handle.agent }))
      .contexts.find(entry => entry.name === 'sandbox:policy')?.text
    expect(context).toContain(`Additional writable directories: ${JSON.stringify([shared, lib])}`)

    // A detached copy of the same log is not an Agent start and receives nothing.
    // oxlint-disable-next-line typescript/no-deprecated -- the test copies the full log.
    const copy = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(copy.additionalPaths).toEqual([lib])
    expect(ctx.sandboxPolicy.resolve({ session: copy }).additionalWritableRoots).toEqual([shared])

    await handle.dispose()
    expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toEqual([shared])
  })

  it('skips a recorded root that is missing, a file, or a symlink and grants the rest', async () => {
    const { ctx, base, app, lib, shared } = await mounted()
    const missing = join(base, 'removed')
    const file = join(base, 'file.txt')
    const link = join(base, 'link')
    await writeFile(file, 'not a directory')
    await symlink(lib, link, 'dir')
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('stale-roots'),
      meta: { cwd: app, additionalPaths: [missing, file, link, lib] },
    })
    expect(handle.agent.session.additionalPaths).toEqual([missing, file, link, lib])
    expect(ctx.sandboxPolicy.resolve({ session: handle.agent.session }).additionalWritableRoots).toEqual([shared, lib])
    await handle.dispose()
  })

  it('leaves a Session without recorded roots on the configured grants only', async () => {
    const { ctx, app, shared } = await mounted()
    const handle = await ctx.agents.create({ sessionId: brandString<SessionId>('single-root'), meta: { cwd: app } })
    expect(handle.agent.session.additionalPaths).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: handle.agent.session }).additionalWritableRoots).toEqual([shared])
    await handle.dispose()
  })
})

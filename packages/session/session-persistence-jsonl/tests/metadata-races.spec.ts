import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '../src/index.ts'
import { logPath, projectDir, sessionDir, toHeaderLine } from '../src/format.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  beforeOpen: new Map<string, () => Promise<void>>(),
  beforeReaddir: new Map<string, () => Promise<void>>(),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await io.beforeOpen.get(String(args[0]))?.()
      return actual.open(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await io.beforeReaddir.get(String(args[0]))?.()
      return actual.readdir(...args)
    },
  }
})

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  io.beforeOpen.clear()
  io.beforeReaddir.clear()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-metadata-race-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', listConcurrency: 2 })
  return { ctx, root }
}

describe('JSONL metadata read races', () => {
  it('omits a generation removed between revision stat and header open', async () => {
    const { ctx, root } = await fixture()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('removed-before-header'), createdAt: 1, isSeeded: false }
    await mkdir(sessionDir(root, undefined, header.id), { recursive: true })
    const path = logPath(root, undefined, header.id, 'none')
    await writeFile(path, `${JSON.stringify(toHeaderLine(header))}\n`)
    const remove = vi.fn(async () => {
      io.beforeOpen.delete(path)
      await rm(path)
    })
    io.beforeOpen.set(path, remove)

    await expect(ctx.sessionPersistence.list()).resolves.toEqual([])
    expect(remove).toHaveBeenCalledOnce()
    await expect(ctx.sessionPersistence.stat(header.id)).resolves.toBeUndefined()
  })

  it('reports the first project in input order when concurrent failures complete out of order', async () => {
    const { ctx, root } = await fixture()
    const projects = ['/a', '/b', '/c'].map(cwd => projectDir(root, cwd)).sort()
    for (const project of projects) await mkdir(project, { recursive: true })
    const releaseFirst = Promise.withResolvers<undefined>()
    const thirdEntered = Promise.withResolvers<undefined>()
    const firstError = Object.assign(new Error('first project unavailable'), { code: 'EIO' })
    const secondError = Object.assign(new Error('second project unavailable'), { code: 'EACCES' })
    io.beforeReaddir.set(projects[0]!, async () => { await releaseFirst.promise; throw firstError })
    io.beforeReaddir.set(projects[1]!, async () => { throw secondError })
    io.beforeReaddir.set(projects[2]!, async () => { thirdEntered.resolve(undefined) })
    const listing = ctx.sessionPersistence.list()
    const rejected = expect(listing).rejects.toBe(firstError)
    try {
      // Worker two can enter project three only after collecting project two's failure.
      await thirdEntered.promise
      releaseFirst.resolve(undefined)
      await rejected
    } finally {
      releaseFirst.resolve(undefined)
      await listing.catch(() => undefined)
    }
  })
})

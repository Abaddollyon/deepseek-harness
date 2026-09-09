import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../src/launcher.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; source: string; cwd: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-package-links-'))
  roots.push(root)
  const source = join(root, 'cordis.snapshot.yml')
  const cwd = join(root, 'workspace')
  const target = join(root, 'materialized')
  await mkdir(target)
  await writeFile(source, '- insert:\n  - name: "@deepseek-ai/dsh-llm-replay"\n')
  return { root, source, cwd, target }
}

function replayLink(cwd: string): string {
  return join(cwd, '.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-replay')
}

describe('snapshot profile package links', () => {
  it('links the harness-owned replay dependency when the patch has no package installation', async () => {
    const { source, cwd, target } = await fixture()
    const materialized = materializeProfilePatch(source, cwd, target, 0)
    const replayPackage = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-replay/package.json')))
    expect(await realpath(replayLink(cwd))).toBe(await realpath(replayPackage))
    expect(await readFile(materialized, 'utf8')).toContain('@deepseek-ai/dsh-llm-replay')
  })

  it('does not link an undeclared package found through harness ancestry', async () => {
    const { source, cwd, target } = await fixture()
    expect(createRequire(import.meta.url).resolve('typescript')).toContain('node_modules')
    await writeFile(source, '- insert:\n  - name: "typescript"\n')
    materializeProfilePatch(source, cwd, target, 0)
    await expect(realpath(join(cwd, '.dsh/profiles/node_modules/typescript'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a patch-local package ahead of the harness dependency', async () => {
    const { root, source, cwd, target } = await fixture()
    const local = join(root, 'node_modules/@deepseek-ai/dsh-llm-replay')
    await mkdir(local, { recursive: true })
    await writeFile(join(local, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-replay', version: '9.0.0' }))
    materializeProfilePatch(source, cwd, target, 0)
    expect(await realpath(replayLink(cwd))).toBe(await realpath(local))
  })
})

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, initProfile, loadProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const baseRoot = fileURLToPath(new URL('../../../bundle/base/', import.meta.url))

it('loads base plus Codex bundle and inserts one complete search row', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-profile-'))
  try {
    const install = join(root, 'install')
    const modules = join(install, 'node_modules', '@deepseek-ai')
    mkdirSync(modules, { recursive: true })
    symlinkSync(baseRoot, join(modules, 'dsh-base'), 'junction')
    symlinkSync(packageRoot, join(modules, 'dsh-web-search-codex'), 'junction')
    const installAnchor = join(install, 'package.json')
    writeFileSync(installAnchor, JSON.stringify({
      name: 'dsh-install',
      dependencies: {
        '@deepseek-ai/dsh-base': '0.0.0',
        '@deepseek-ai/dsh-web-search-codex': '0.0.0',
      },
    }))

    const home = join(root, 'home')
    const profileDir = resolveProfileDir('codex', home)
    initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-search-codex'])
    const warnings: string[] = []
    const profile = loadProfile('test', 'codex', installAnchor, home)
    const entries = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], warning => warnings.push(warning))
    const codexRows = entries.filter(entry => entry.id === 'web-search-codex')

    expect(codexRows).toHaveLength(1)
    expect(codexRows[0]).toEqual({
      id: 'web-search-codex',
      name: '@deepseek-ai/dsh-web-search-codex',
      inject: ['web', 'subprocess'],
    })
    expect(warnings).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

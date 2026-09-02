import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/web/subscription-search/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'claude.cordis.yml')
const claudePatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('official Claude search Loader composition', () => {
  it('loads the public Bundle provider without probing authentication or spawning Claude', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'Claude search Loader composition',
      tempDirPrefix: 'dsh-claude-search-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, claudePatch],
      tsconfigPath: repoTsconfig,
      env: { PATH: '', DSH_FIXTURE_LOAD_ONLY: '1' },
    })
    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as { providers: string[]; outcomes: unknown[] }
    expect(output).toEqual({ providers: ['claude-code', 'codex'], outcomes: [] })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

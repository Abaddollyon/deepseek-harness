import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/web/subscription-search/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'codex.cordis.yml')
const codexPatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('official subscription search Loader composition', () => {
  it('loads both Bundle providers and returns a model-visible Codex search result', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'subscription search Loader composition',
      tempDirPrefix: 'dsh-subscription-search-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, codexPatch],
      tsconfigPath: repoTsconfig,
      env: { PATH: '' },
    })
    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as {
      providers: string[]
      outcomes: Array<{ query: string; result?: { sources: Array<{ url: string }> } }>
    }
    expect(output.providers).toEqual(['claude-code', 'codex'])
    expect(output.outcomes).toEqual([{
      query: 'loader query',
      result: {
        sources: [{ url: 'https://loader.example/result', title: 'Loader result' }],
        truncated: false,
      },
    }])
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

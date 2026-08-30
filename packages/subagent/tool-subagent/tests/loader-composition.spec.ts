import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

interface CompositionReport {
  lifecycle: {
    start: { provider: string; id: string; local: boolean }
    end: {
      provider: string
      id: string
      local: boolean
      stopReason: string
      lastAssistantMessage?: { type: string; text?: string }[]
      failure?: { code: string; retryAfterMs?: number }
    }
    pairedRunId: boolean
  }
  result: {
    isError: boolean
    text: string
    error: { message: string } | null
  }
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('tool-subagent Loader composition', () => {
  it('preserves the structured provider failure through the composed tool end to end', async () => {
    let report: CompositionReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'tool-subagent failure composition smoke',
      tempDirPrefix: 'tool-subagent-failure-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'tool-subagent-report.json'), 'utf8')) as CompositionReport
      },
    })

    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toEqual({
      lifecycle: {
        start: {
          provider: 'mock',
          id: 'scripted-subagent:mock:loader-parent',
          local: false,
        },
        end: {
          provider: 'mock',
          id: 'scripted-subagent:mock:loader-parent',
          local: false,
          stopReason: 'error',
          lastAssistantMessage: [{ type: 'text', text: 'partial child answer' }],
          failure: { code: 'QUOTA' },
        },
        pairedRunId: true,
      },
      result: {
        isError: true,
        text: 'Error: subagent run failed\n'
          + 'Diagnostic: provider quota exhausted on this route\n'
          + 'Failure code: QUOTA\n'
          + 'Partial output before the run ended:\npartial child answer',
        error: {
          message: 'subagent run failed\n'
            + 'Diagnostic: provider quota exhausted on this route\n'
            + 'Failure code: QUOTA\n'
            + 'Partial output before the run ended:\npartial child answer',
        },
      },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

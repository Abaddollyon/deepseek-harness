/**
 * Failure-path tests for the lazy packaged-ripgrep resolution. The success
 * path (the real `@vscode/ripgrep` module) is exercised throughout
 * tools.spec.ts; here the module is mocked to throw at evaluation, proving a
 * missing or corrupt platform package (`--omit=optional`, partial install)
 * surfaces as a per-call `SEARCH_FAILED` — not a composition-load failure.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveRgPath, runRipgrep } from '@deepseek-ai/dsh-tool-fs-search'

// Any access to the mocked module's surface throws — the shape a missing
// platform package produces at module evaluation.
vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('platform package @vscode/ripgrep-win32-x64 is not installed')
  },
}))

function execution(id: string): ToolExecution {
  return { signal: new AbortController().signal, name: 'glob', callId: ToolCallId(id) } as never
}

describe('lazy packaged-ripgrep resolution', () => {
  it('fails the first search call with SEARCH_FAILED instead of failing module load', async () => {
    // The resolution rejects before any spawn, so no subprocess service is needed.
    await expect(runRipgrep(new Context(), execution('missing-platform-package'), 'glob', ['--files'], 1_000_000, 3_000, 64 * 1024))
      .rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
  })

  it('keeps failing every subsequent call (the resolution is memoized)', async () => {
    await expect(resolveRgPath()).rejects.toThrow(/platform package/)
    await expect(resolveRgPath()).rejects.toThrow(/platform package/)
  })

  it('spawns a configured executable without resolving the packaged binary', async () => {
    const ctx = new Context()
    const argv: string[][] = []
    const empty = { readFrom: () => ({ text: '', lossy: false }) }
    ctx.provide('subprocess', {
      spawn: (spec: { argv: string[] }) => {
        argv.push(spec.argv)
        return { done: Promise.resolve({ exitCode: 1, signal: null }), collected: { stdout: empty, stderr: empty } }
      },
    } as never)
    await expect(runRipgrep(ctx, execution('configured-rg'), 'glob', ['--files'], 1_000_000, 3_000, 64 * 1024, '/opt/remote/rg'))
      .resolves.toMatchObject({ noMatches: true })
    expect(argv).toEqual([['/opt/remote/rg', '--no-config', '--files']])
  })
})

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '../../../../../../packages/subprocess/subprocess-local/src/index.ts'
import { CodexSearchProvider } from '../../../../../../packages/web/web-search-codex/src/provider.ts'
import { ClaudeCodeSearchProvider } from '../../../../../../packages/web/web-search-claude-code/src/provider.ts'
import { createClaudeQueryReplay } from '../../../../../../packages/web/web-search-claude-code/tests/fixtures/sdk-query.ts'

export interface SubscriptionFixtureSnapshot {
  provider: 'codex' | 'claude-code'
  process: { active: number; settled: number; spawned: number }
  result: unknown
  sdk?: { closed: number; prompts: number; spawns: number }
}

/** Execute one subscription provider against its package-owned keyless replay. */
export async function runSubscriptionFixture(
  ctx: Context,
  providerId: 'codex' | 'claude-code',
  codexServer: string,
): Promise<SubscriptionFixtureSnapshot> {
  const local = new LocalSubprocessRuntime(ctx)
  const children = new Set<SubprocessHandle>()
  let spawned = 0
  let settled = 0
  const runtime = {
    resolveExecutable: async (command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) =>
      await local.resolveExecutable(command, env, signal),
    spawn: (spec: SubprocessSpawnSpec) => {
      const child = local.spawn(spec)
      children.add(child)
      spawned += 1
      void child.done.then(
        () => { children.delete(child); settled += 1 },
        () => { children.delete(child); settled += 1 },
      )
      return child
    },
    spawnTerminal: async spec => await local.spawnTerminal(spec),
  } as SubprocessRuntime
  const request = { query: 'subscription fixture query', maxResults: 3 }
  if (providerId === 'codex') {
    const provider = new CodexSearchProvider(runtime, {
      cwd: '.', requestTimeoutMs: 5_000, disposeGraceMs: 250,
      maxResults: 3, maxPayloadBytes: 262_144, executable: codexServer,
    })
    try {
      const result = await provider.search(request)
      return { provider: providerId, result, process: { active: children.size, spawned, settled } }
    } finally {
      await provider.dispose()
    }
  }
  const sdk = { closed: 0, prompts: [] as string[], spawns: 0 }
  const provider = new ClaudeCodeSearchProvider({ subprocess: runtime } as Context, {
    cwd: '.', requestTimeoutMs: 5_000, disposeGraceMs: 250, maxResults: 3,
    maxTurns: 1, maxPayloadBytes: 262_144, executable: process.execPath,
    query: createClaudeQueryReplay(sdk),
  })
  try {
    const result = await provider.search(request)
    return {
      provider: providerId,
      result,
      process: { active: children.size, spawned, settled },
      sdk: { closed: sdk.closed, prompts: sdk.prompts.length, spawns: sdk.spawns },
    }
  } finally {
    await provider.dispose()
  }
}

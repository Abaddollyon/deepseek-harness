import type { query as officialQuery } from '@anthropic-ai/claude-agent-sdk'

/** State captured by the deterministic SDK-query replay. */
export interface ClaudeQueryReplayState {
  closed: number
  prompts: string[]
  spawns: number
  unavailable?: boolean
  authFailure?: boolean
}

/** Create a keyless SDK query double that still uses the provider's managed-process callback. */
export function createClaudeQueryReplay(state: ClaudeQueryReplayState): typeof officialQuery {
  return ((input: {
    prompt: string
    options: {
      abortController: AbortController
      spawnClaudeCodeProcess(options: Record<string, unknown>): unknown
    }
  }) => {
    state.prompts.push(input.prompt)
    if (state.unavailable === true) throw Object.assign(new Error('Claude Code executable unavailable'), { code: 'ENOENT' })
    const child = input.options.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ['-e', ''],
      cwd: process.env.DSH_REPLAY_CWD ?? process.env.PWD ?? '/replay/subscription-web-search',
      env: {},
      signal: input.options.abortController.signal,
    }) as { once(event: 'exit', listener: () => void): void }
    state.spawns += 1
    const marker = 'Use WebSearch exactly once for this query: '
    const query = input.prompt.split(marker)[1]?.split('\n', 1)[0] ?? 'offline-query'
    const sources = Array.from({ length: 6 }, (_, index) => ({
      url: `https://subscription.example.test/${encodeURIComponent(query)}/${index + 1}`,
      title: `Subscription result ${index + 1}`,
      snippet: `Offline subscription replay source ${index + 1} for ${query}.`,
      publishedAt: `2001-01-0${index + 1}T00:00:00Z`,
    }))
    const iterator = (async function* () {
      await new Promise<void>((resolve) => { child.once('exit', resolve) })
      yield { type: 'user', tool_use_result: { query, results: sources } } as never
      yield {
        type: 'result',
        subtype: state.authFailure === true ? 'error_during_execution' : 'success',
        ...(state.authFailure === true ? { errorClass: 'unauthenticated' } : {}),
        structured_output: {
          query,
          answer: `Offline Claude Code answer for ${query}.`,
          sources,
          truncated: false,
        },
      } as never
    })()
    return Object.assign(iterator, { close: () => { state.closed += 1 } })
  }) as unknown as typeof officialQuery
}

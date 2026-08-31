/** Test driver for one structured subagent failure through the real Loader tree. */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('tool-subagent driver requires a config path')

const ctx = await boot('tool-subagent-failure-e2e', resolveConfigPath(configPath, undefined))
try {
  const starts: SubagentRunInfo[] = []
  const ends: SubagentRunEndInfo[] = []
  ctx.on('subagent/start', info => void starts.push(info))
  ctx.on('subagent/end', info => void ends.push(info))
  const parent = ctx.agentLoop.create(SessionId('loader-parent'), {
    provider: 'unused',
    model: 'unused',
  })
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('loader-subagent'),
    name: 'subagent',
    arguments: { description: 'd', prompt: 'p' },
    agent: parent,
  })
  const text = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const start = starts[0]
  const end = ends[0]
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined) {
    throw new Error('expected one paired subagent lifecycle')
  }
  await writeFile('tool-subagent-report.json', JSON.stringify({
    lifecycle: {
      start: { provider: start.provider, id: start.id, local: start.local },
      end: {
        provider: end.provider,
        id: end.id,
        local: end.local,
        stopReason: end.stopReason,
        ...end.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: end.lastAssistantMessage },
        ...end.failure === undefined ? {} : { failure: end.failure },
      },
      pairedRunId: start.runId === end.runId,
    },
    result: {
      isError: result.isError,
      text,
      error: result.error === undefined ? null : { message: result.error.message },
    },
  }))
} finally {
  await ctx.fiber.dispose()
}

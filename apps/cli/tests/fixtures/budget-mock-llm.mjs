import { appendFileSync } from 'node:fs'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'

/** Keyless adapter for proving native headless budget enforcement in a real process. */
class BudgetMockAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    const off = ReasoningEffortId('off')
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: off, name: 'Off' }] },
    }
  }

  async * stream(options) {
    appendFileSync(process.env.DSH_BUDGET_MOCK_REQUESTS_FILE, `${JSON.stringify({
      sessionId: String(options.sessionId),
      toolCount: options.tools?.length ?? 0,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    })}\n`)
    const argumentsJson = JSON.stringify({ command: 'printf NATIVE_BUDGET_PROOF' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: ToolCallId('native-budget-call'),
      name: process.platform === 'win32' ? 'pwsh' : 'bash',
      argumentsDelta: argumentsJson,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: ToolCallId('native-budget-call'),
        name: process.platform === 'win32' ? 'pwsh' : 'bash',
        arguments: argumentsJson,
      },
    }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'budget-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['budget-mock'], new BudgetMockAdapter())
}

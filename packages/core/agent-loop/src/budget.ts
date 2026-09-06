import type { AgentBudget } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, PreparedLlmCall, TokenUsage } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Stateful execution-limit owner for one live React loop instance. */
export class AgentBudgetTracker {
  private steps = 0
  private inputTokens = 0
  private outputTokens = 0
  private retries = 0
  private inputAccountingAvailable = true

  constructor(private readonly limit: Readonly<AgentBudget>) {}

  /** Admit one model step before its durable step boundary opens. */
  admitStep(): void {
    if (this.steps >= this.limit.maxTurns) {
      throw this.exceeded('model step', this.limit.maxTurns)
    }
    this.steps += 1
  }

  /** Clamp one proposed call to the remaining total output allowance. */
  clampOutput(config: LlmCallConfig): LlmCallConfig {
    if (!this.inputAccountingAvailable) {
      throw new LlmError(
        'agent input-token budget cannot admit another request because the previous response reported no usage',
        'BUDGET_ACCOUNTING_UNAVAILABLE',
      )
    }
    const remaining = this.limit.maxOutputTokens - this.outputTokens
    if (remaining <= 0) throw this.exceeded('output token', this.limit.maxOutputTokens)
    return { ...config, maxTokens: Math.min(config.maxTokens ?? remaining, remaining) }
  }

  /** Price and reserve exact input before provider dispatch. */
  admitRequest(request: GenerateOptions, prepared: PreparedLlmCall | undefined): number | undefined {
    if (!this.inputAccountingAvailable) {
      throw new LlmError(
        'agent input-token budget cannot admit another request because the previous response reported no usage',
        'BUDGET_ACCOUNTING_UNAVAILABLE',
      )
    }
    if (this.inputTokens >= this.limit.maxInputTokens) {
      throw this.exceeded('input token', this.limit.maxInputTokens)
    }
    const count = prepared?.countInputTokens(request)
    if (count === undefined) return undefined
    if (this.inputTokens + count > this.limit.maxInputTokens) {
      throw this.exceeded('input token', this.limit.maxInputTokens)
    }
    this.inputTokens += count
    return count
  }

  /** Reconcile one dispatched request with authoritative provider usage. */
  settleRequest(request: GenerateOptions, admittedInput: number | undefined, usage: TokenUsage | undefined): void {
    if (usage === undefined) {
      if (admittedInput === undefined) this.inputAccountingAvailable = false
    } else {
      const reportedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      this.inputTokens += reportedInput - (admittedInput ?? 0)
    }
    this.outputTokens += usage?.outputTokens ?? request.maxTokens ?? this.limit.maxOutputTokens
    if (this.outputTokens > this.limit.maxOutputTokens) {
      throw this.exceeded('output token', this.limit.maxOutputTokens)
    }
  }

  /** Admit one additional dispatch after request-error recovery. */
  admitRetry(): void {
    if (this.retries >= this.limit.maxRetries) {
      throw this.exceeded('retry', this.limit.maxRetries)
    }
    this.retries += 1
  }

  private exceeded(kind: string, limit: number): LlmError {
    return new LlmError(`agent exceeded its ${kind} limit of ${String(limit)}`, 'BUDGET_EXCEEDED')
  }
}

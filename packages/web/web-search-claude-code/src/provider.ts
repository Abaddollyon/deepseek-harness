/** Official Claude Agent SDK implementation of native batched web search. */

import {
  query as officialQuery,
  type Options as ClaudeOptions,
  type Query,
  type SDKMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import { disposeManagedSubprocess, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  createNativeProviderAbortScope,
  filterWebSearchSourcesByDomains,
  NativeBatchSearchProvider,
  WebError,
  type WebSearchBatchOutcome,
  type WebSearchBatchRequest,
  type WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { claudeSpawnSpec, ManagedClaudeCodeProcess } from './process.ts'

/** Stable provider id selected by web runtime config. */
export const CLAUDE_CODE_SEARCH_PROVIDER_ID = 'claude-code'
/** Default managed process-tree termination grace. */
export const DEFAULT_CLAUDE_CODE_SEARCH_GRACE_MS = 3_000
/** Default SDK conversation turn bound for one search batch. */
export const DEFAULT_CLAUDE_CODE_SEARCH_MAX_TURNS = 4

/** Validated runtime options for one Claude Code search provider. */
export interface ClaudeCodeSearchProviderOptions {
  readonly cwd: string
  readonly graceMs: number
  readonly maxTurns: number
}

interface StructuredOutcome {
  readonly query: string
  readonly answer?: string
}

interface RawSearch {
  readonly query: string
  readonly sources: readonly WebSearchSource[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeProtocolOutcome(query: string): WebSearchBatchOutcome {
  return {
    query,
    error: {
      code: 'WEB_PROVIDER_PROTOCOL',
      message: 'Claude Code returned incomplete structured web search data',
    },
  }
}

function parseRawSearch(value: unknown): RawSearch | undefined {
  const output = record(value)
  if (typeof output?.query !== 'string' || !Array.isArray(output.results)) return undefined
  const sources: WebSearchSource[] = []
  for (const item of output.results) {
    const result = record(item)
    if (!Array.isArray(result?.content)) continue
    for (const candidate of result.content) {
      const source = record(candidate)
      if (typeof source?.url !== 'string') continue
      sources.push({
        url: source.url,
        ...typeof source.title === 'string' ? { title: source.title } : {},
      })
    }
  }
  return { query: output.query, sources }
}

function parseStructuredOutcomes(
  value: unknown,
  queries: readonly string[],
): readonly StructuredOutcome[] | undefined {
  const root = record(value)
  if (!Array.isArray(root?.outcomes) || root.outcomes.length !== queries.length) return undefined
  const outcomes: StructuredOutcome[] = []
  for (let index = 0; index < queries.length; index += 1) {
    const item = record(root.outcomes[index])
    const query = queries[index]
    /* v8 ignore next -- the loop index is bounded by queries.length. */
    if (query === undefined || item?.query !== query) return undefined
    if (item.answer !== undefined && typeof item.answer !== 'string') return undefined
    outcomes.push({ query, ...typeof item.answer === 'string' ? { answer: item.answer } : {} })
  }
  return outcomes
}

function uniqueQueries(queries: readonly string[]): readonly string[] {
  return [...new Set(queries)]
}

function outputSchema(queryCount: number): NonNullable<ClaudeOptions['outputFormat']> {
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcomes: {
          type: 'array',
          minItems: queryCount,
          maxItems: queryCount,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              answer: { type: 'string' },
            },
            required: ['query'],
          },
        },
      },
      required: ['outcomes'],
    },
  }
}

function batchPrompt(request: WebSearchBatchRequest): string {
  return [
    'Run exactly one WebSearch tool call for each query below. Do not use any other tool.',
    'Use each query string exactly as written and preserve input order.',
    request.allowedDomains === undefined
      ? undefined
      : `Pass allowed_domains=${JSON.stringify(request.allowedDomains)} to every WebSearch call.`,
    request.blockedDomains === undefined
      ? undefined
      : `Pass blocked_domains=${JSON.stringify(request.blockedDomains)} to every WebSearch call.`,
    request.location === undefined
      ? undefined
      : `Prefer results relevant to this user location: ${JSON.stringify(request.location)}.`,
    'Return structured output with outcomes in exact input order. Keep answer concise and grounded only in WebSearch results.',
    `Queries: ${JSON.stringify(request.queries)}`,
  ].filter((line): line is string => line !== undefined).join('\n')
}

function disposeQuery(query: Query | undefined, child: SubprocessHandle | undefined): Promise<void> {
  return disposeManagedSubprocess(child, () => query?.close(), 'Claude Code web search teardown failed')
}

/** Official subscription-native Claude Code search provider. */
export class ClaudeCodeSearchProvider extends NativeBatchSearchProvider {
  readonly id = CLAUDE_CODE_SEARCH_PROVIDER_ID

  constructor(
    private readonly ctx: Context,
    private readonly options: ClaudeCodeSearchProviderOptions,
  ) {
    super()
  }

  /** Run every query in one official SDK session with only WebSearch enabled. */
  async searchMany(
    request: WebSearchBatchRequest,
    signal?: AbortSignal,
  ): Promise<readonly WebSearchBatchOutcome[]> {
    const abortScope = createNativeProviderAbortScope(signal)
    const { controller } = abortScope
    let query: Query | undefined
    let child: SubprocessHandle | undefined
    let primaryFailure: unknown
    const providerRequest = { ...request, queries: uniqueQueries(request.queries) }
    try {
      const raw = new Map<string, RawSearch[]>()
      let structured: unknown
      query = officialQuery({
        prompt: batchPrompt(providerRequest),
        options: {
          abortController: controller,
          cwd: this.options.cwd,
          tools: ['WebSearch'],
          allowedTools: ['WebSearch'],
          permissionMode: 'dontAsk',
          persistSession: false,
          maxTurns: this.options.maxTurns,
          outputFormat: outputSchema(providerRequest.queries.length),
          spawnClaudeCodeProcess: (spawn: SpawnOptions) => {
            if (child !== undefined) throw new Error('Claude Code SDK attempted more than one process spawn')
            child = this.ctx.subprocess.spawn(claudeSpawnSpec(spawn, this.options.graceMs))
            return new ManagedClaudeCodeProcess(child)
          },
        },
      })
      for await (const message of query as AsyncIterable<SDKMessage>) {
        if (message.type === 'user' && message.tool_use_result !== undefined) {
          const parsed = parseRawSearch(message.tool_use_result)
          if (parsed !== undefined) raw.set(parsed.query, [...raw.get(parsed.query) ?? [], parsed])
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') {
            throw new WebError('Claude Code web search session failed', 'WEB_PROVIDER_ERROR')
          }
          structured = message.structured_output
        }
      }
      if (controller.signal.aborted) {
        throw new WebError('web search was cancelled', 'WEB_ABORTED', { cause: signal?.reason })
      }
      const summaries = parseStructuredOutcomes(structured, providerRequest.queries)
      if (summaries === undefined) return request.queries.map(safeProtocolOutcome)
      const mapped = new Map<string, WebSearchBatchOutcome>()
      for (const summary of summaries) {
        const searches = raw.get(summary.query)
        if (searches?.length !== 1) {
          mapped.set(summary.query, safeProtocolOutcome(summary.query))
          continue
        }
        const search = searches[0]
        /* v8 ignore next -- the preceding length check proves one entry. */
        if (search === undefined) continue
        mapped.set(summary.query, {
          query: summary.query,
          result: {
            ...summary.answer === undefined ? {} : { content: summary.answer },
            sources: filterWebSearchSourcesByDomains(search.sources, request),
            truncated: false,
          },
        })
      }
      return request.queries.map((query) => {
        const outcome = mapped.get(query)
        /* v8 ignore next -- unique summaries populate every original query key. */
        return outcome ?? safeProtocolOutcome(query)
      })
    } catch (error: unknown) {
      primaryFailure = error
      if (controller.signal.aborted) {
        throw new WebError('web search was cancelled', 'WEB_ABORTED', { cause: signal?.reason })
      }
      if (error instanceof WebError) throw error
      throw new WebError('Claude Code web search provider failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      abortScope.dispose()
      controller.abort('Claude Code web search completed')
      try {
        await disposeQuery(query, child)
      } catch (cleanupError: unknown) {
        if (primaryFailure === undefined) {
          throw new WebError('Claude Code web search cleanup failed', 'WEB_PROVIDER_ERROR', { cause: cleanupError })
        }
      }
    }
  }
}

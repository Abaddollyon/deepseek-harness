/**
 * The model-facing `web_search` tool: discover current information on the web.
 * Execution goes through `ctx.web` — this module owns only the model-facing
 * schema, argument validation, the result-count bound, and result formatting,
 * never provider selection or network access.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResult, WebSearchResultView, WebSource } from '@deepseek-ai/dsh-tools'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchBatchError, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Default upper bound on returned sources (the `searchMaxResults` config).
 * Owned by the consumer (not the provider or model), mirroring `dsh-tool-fs`'s
 * `READ_LIMIT`. The model just asks a question; the product controls how much
 * context returns. The default `8` aligns with OpenCode's Exa default.
 */
export const WEB_SEARCH_MAX_RESULTS = 8

/** Default upper bound on concurrent searches in one tool call. */
export const WEB_SEARCH_MAX_QUERIES = 4

/** Model-facing `web_search` arguments. */
interface WebSearchArgs {
  queries: string[]
}

/** Safe failure details retained for partial batch results and replay metadata. */
export interface WebSearchFailure extends WebSearchBatchError {
  readonly query: string
}

interface SearchExecution {
  readonly result: WebSearchResult
  readonly failures: readonly WebSearchFailure[]
}

interface WebSearchOutput extends WebSearchResult {
  readonly failures?: readonly WebSearchFailure[]
}

/**
 * Validate value constraints the schema DSL can't express: `queries` is
 * non-empty, contains only non-blank strings, and fits the deployment's
 * query-count bound. Exact duplicate strings are collapsed after the bound
 * check. Throws a plain `Error` otherwise.
 *
 * @param args - the schema-validated `web_search` arguments.
 * @param maxQueries - the deployment's upper bound on queries in one call.
 * @returns the accepted queries in their first-occurrence order.
 */
export function parseSearchArgs(
  args: WebSearchArgs,
  maxQueries: number,
): string[] {
  const queries = args.queries
  if (queries.length === 0) throw new Error('queries must contain at least one query')
  if (queries.length > maxQueries) {
    const noun = maxQueries === 1 ? 'query' : 'queries'
    throw new Error(`queries must contain at most ${maxQueries} ${noun}`)
  }
  if (queries.some(query => query.trim().length === 0)) throw new Error('each query must be a non-empty string')
  return [...new Set(queries)]
}

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    // A provider should return a valid URL, but never let a malformed one throw
    // out of pure formatting — fall back to the raw string.
    return url
  }
}

/**
 * Format a search result as one model-facing text block.
 *
 * @param result - the seam's search outcome.
 * @returns the provider answer (when any), a markdown source list with snippet
 *   and date metadata (or `No results found.`), a refine-the-query note when
 *   truncated, and a standing cite-your-sources instruction.
 */
export function formatSearchOutput(result: WebSearchOutput): string {
  const parts: string[] = []
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)
  if (result.failures !== undefined && result.failures.length > 0) {
    const lines = result.failures.map(failure => `- ${failure.query}: [${failure.code}] ${failure.message}`)
    parts.push(`### Partial failures\n\n${lines.join('\n')}`)
  }

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if ((result.content === undefined || result.content.length === 0)
    && (result.failures === undefined || result.failures.length === 0)) {
    parts.push('No results found.')
  }

  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  if (result.sources.length > 0) parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/**
 * Pending-call presentation: a search card titled by the query list.
 *
 * @param args - the raw tool arguments; only the query text feeds the view.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentSearchCall(args: WebSearchArgs): GenericCallView {
  const title = args.queries.join(', ')
  return { card: 'generic', title, kind: 'search', rawInput: title }
}

/**
 * The `web_search` tool's private `tool/result` `meta` payload: the structured
 * sources, the optional provider answer, and the truncation flag. Attached
 * opaquely (as `JsonValue`) on the tool result and persisted with the session
 * log, so `presentResult` reproduces the search card on replay. This projection
 * is the only faithful route to the per-source fields, which the lossy render
 * text cannot carry (the owning rationale is the web-result-card Agent Note).
 */
export interface WebSearchMeta {
  /** The faithful structured sources, in result order. */
  sources: WebSource[]
  /** True when the seam or multi-query merge cut the source list to honor the result cap. */
  truncated: boolean
  /** The provider-generated answer text, when any. */
  answer?: string
  /** Per-query safe failures retained when other queries succeeded. */
  failures?: WebSearchFailure[]
}

/**
 * Project one seam source into a plain object that omits every absent optional
 * field. Shared by the canonical `execute` result and its replayable
 * presentation meta so both carry byte-identical source shapes.
 *
 * @param source - one source from the `ctx.web` search outcome.
 * @returns `{ url }` plus each present optional field.
 */
function projectSource(source: WebSearchSource): {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
} {
  return {
    url: source.url,
    ...source.title !== undefined ? { title: source.title } : {},
    ...source.snippet !== undefined ? { snippet: source.snippet } : {},
    ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
  }
}

/**
 * Project a validated `web_search` output value into its replayable
 * presentation meta ({@link WebSearchMeta} as opaque JSON).
 *
 * @param value - the canonical `web_search` output value (the seam's result shape).
 * @returns the structured sources, the truncation flag, and the answer when present.
 */
export function searchMetaFromValue(value: WebSearchOutput): JsonValue {
  const failures = value.failures
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
    ...value.content !== undefined ? { answer: value.content } : {},
    ...failures !== undefined && failures.length > 0 ? { failures: failures.map(failure => ({ ...failure })) } : {},
  }
}

/** Whether `value` is a valid {@link WebSource} (defensive narrowing from opaque `meta`). */
function isWebSource(value: unknown): value is WebSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet, publishedAt } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

function isWebSearchFailure(value: unknown): value is WebSearchFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { query, code, message } = value as Record<string, unknown>
  return typeof query === 'string' && typeof code === 'string' && typeof message === 'string'
}

/**
 * Narrow opaque live or replayed result metadata to a {@link WebSearchMeta}.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic card instead of throwing during replay.
 *
 * @param meta - result metadata.
 * @returns the validated search meta, or `undefined` for absent or malformed data.
 */
export function searchMetaFromResult(meta: unknown): WebSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated, answer, failures } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || !sources.every(isWebSource)) return undefined
  if (typeof truncated !== 'boolean') return undefined
  if (answer !== undefined && typeof answer !== 'string') return undefined
  if (failures !== undefined && (!Array.isArray(failures) || !failures.every(isWebSearchFailure))) return undefined
  return {
    sources,
    truncated,
    ...answer !== undefined ? { answer } : {},
    ...failures !== undefined ? { failures } : {},
  }
}

/**
 * Completed-call presentation: a `web` search card carrying the faithful
 * structured sources from `meta`. It sets no `content` copy — a UI without the
 * `web` capability falls back to the raw `tool/result` content, which is the
 * same text (see the web-result-card Agent Note).
 *
 * @param args - the raw tool arguments; the queries become the result-state
 *   title so a window-truncated replay that dropped the call head still has one.
 * @param result - the final model-facing tool result; `meta` carries the sources.
 * @returns the search result view, or `undefined` (generic card) on failure or
 *   malformed meta.
 */
export function presentSearchResult(args: WebSearchArgs, result: ToolResult): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.queries.join(', '),
    sources: meta.sources,
    truncated: meta.truncated,
    ...meta.answer !== undefined ? { answer: meta.answer } : {},
    ...meta.failures !== undefined ? { failures: meta.failures } : {},
  }
}

/**
 * Run one or more searches through the web seam. A single query retains the
 * existing throw-on-failure behavior. Multiple queries use one provider batch,
 * merge successful results, and retain safe per-query failures.
 *
 * @param ctx - context whose `web` service performs the searches.
 * @param queries - validated non-empty queries.
 * @param maxResults - the deployment's source cap for the combined result.
 * @param signal - cancellation signal forwarded to the selected provider.
 * @returns the combined result and replayable partial failures.
 */
async function runSearchQueries(
  ctx: Context,
  queries: string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<SearchExecution> {
  if (queries.length === 1) {
    return {
      result: await ctx.web.search({ query: queries[0] as string, maxResults }, signal),
      failures: [],
    }
  }
  const outcomes = await ctx.web.searchMany({ queries, maxResults }, signal)
  const successes: { query: string; result: WebSearchResult }[] = []
  const failures: WebSearchFailure[] = []
  for (const outcome of outcomes) {
    if (outcome.result !== undefined) successes.push({ query: outcome.query, result: outcome.result })
    else if (outcome.error !== undefined) failures.push({ query: outcome.query, ...outcome.error })
  }
  if (successes.length === 0 && failures.length > 0) {
    const [failure] = failures
    if (failure === undefined) throw new WebError('web search batch failed', 'WEB_PROVIDER_PROTOCOL')
    throw new WebError(failure.message, failure.code)
  }
  return {
    result: mergeSearchResults(successes, maxResults),
    failures,
  }
}

/** Merge per-query results into one deduplicated, round-robin, capped result. */
function mergeSearchResults(
  successes: readonly { query: string; result: WebSearchResult }[],
  maxResults: number,
): WebSearchResult {
  const results = successes.map(success => success.result)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  let sourceRanks = 0
  for (const result of results) {
    sourceRanks = Math.max(sourceRanks, result.sources.length)
  }
  let droppedSource = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url)
        if (sources.length === maxResults) {
          droppedSource = true
          break merge
        }
        sources.push(source)
      }
    }
  }
  const contents = successes.flatMap(({ query, result }) => {
    if (result.content === undefined || result.content.length === 0) return []
    return [`### ${query}\n\n${result.content}`]
  })
  return {
    ...contents.length > 0 ? { content: contents.join('\n\n') } : {},
    sources,
    truncated: results.some(result => result.truncated) || droppedSource,
  }
}

/**
 * Register the `web_search` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param maxResults - the deployment's source cap, sent as every seam
 *   request's `maxResults`.
 * @param maxQueries - the deployment's query cap enforced before provider calls.
 * @param timeoutMs - the cooperative tool-call budget (ms) attached as the tool's
 *   `ToolDefinition.timeoutMs` for `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce.
 * @param fetchEnabled - whether the same composition exposes `web_fetch`, which
 *   controls whether search guidance may recommend that follow-up tool.
 */
export function applyWebSearchTool(
  ctx: Context,
  maxResults: number,
  maxQueries: number,
  timeoutMs: number,
  fetchEnabled: boolean,
): void {
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: fetchEnabled
      ? `Use the web_search tool to discover current information on the web. The required queries array accepts 1–${maxQueries} non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.`
      : `Use the web_search tool to discover current information on the web. The required queries array accepts 1–${maxQueries} non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Use the returned source snippets when available, and cite the relevant URLs as markdown links.`,
  })

  ctx.tools.register(defineTool({
    name: 'web_search',
    description: `Search the web for current information. Provide 1–${maxQueries} queries in the required queries array. Returns an optional summary answer and a list of source URLs.`,
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `Required search queries; accepts 1–${maxQueries} items and merges their results.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: { type: 'string', required: true },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const queries = parseSearchArgs(args, maxQueries)
      const execution = await runSearchQueries(ctx, queries, maxResults, exec.signal)
      const result = {
        ...execution.result.content !== undefined ? { content: execution.result.content } : {},
        sources: execution.result.sources.map(projectSource),
        truncated: execution.result.truncated,
        ...execution.failures.length > 0 ? { failures: execution.failures.map(failure => ({ ...failure })) } : {},
      }
      return result
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  }))
}

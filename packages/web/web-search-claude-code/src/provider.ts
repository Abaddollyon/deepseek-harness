import {
  query as officialQuery,
  type Query,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  WebError,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { claudeSpawnSpec, ManagedClaudeCodeProcess } from '@deepseek-ai/dsh-subagent-claude-code'
/** Provider contract constant. */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
/** Provider contract constant. */
export const DEFAULT_TIMEOUT_MS = 60000
/** Provider contract constant. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000
/** Provider contract constant. */
export const DEFAULT_MAX_RESULTS = 8
/** Provider contract constant. */
export const DEFAULT_MAX_TURNS = 4
/** Provider contract constant. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 262144
/** Provider contract constant. */
export const WEB_ABORTED = 'WEB_ABORTED'
/** Provider contract constant. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'
/** Provider contract constant. */
export const WEB_PROVIDER_PROTOCOL = 'WEB_PROVIDER_PROTOCOL'
/** Provider contract constant. */
export const WEB_INVALID_CONFIG = 'WEB_INVALID_CONFIG'
const unavailable =
  'Sign in with Claude Code (claude login) and retry; DSH does not read provider credentials'
const missing =
  'Claude Code CLI is unavailable; install Claude Code and retry; DSH does not read provider credentials'
/** Runtime options for one Claude Code provider instance. */
export interface ClaudeCodeSearchProviderOptions {
  readonly cwd: string
  readonly requestTimeoutMs: number
  readonly disposeGraceMs: number
  readonly maxResults: number
  readonly maxTurns: number
  readonly maxPayloadBytes: number
  readonly executable?: string
  readonly query?: typeof officialQuery
}
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
function source(v: unknown): WebSearchSource | undefined {
  const x = obj(v)
  if (typeof x?.url !== 'string' || !/^https?:\/\//.test(x.url))
    return undefined
  return {
    url: x.url,
    ...(typeof x.title === 'string' ? { title: x.title } : {}),
    ...(typeof x.snippet === 'string' ? { snippet: x.snippet } : {}),
    ...(typeof x.publishedAt === 'string'
      ? { publishedAt: x.publishedAt }
      : {}),
  }
}
/** Normalize structured SDK output into the WebSearchResult contract.
 * @param value - SDK structured output.
 * @param maxResults - Maximum number of sources.
 * @param maxPayloadBytes - Maximum serialized result size.
 * @returns The normalized web-search result.
 */
export function normalizeResult(
  value: unknown,
  maxResults = DEFAULT_MAX_RESULTS,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): WebSearchResult {
  const x = obj(value)
  if (!x || !Array.isArray(x.sources))
    throw new WebError(
      'Claude Code returned malformed structured web search data',
      WEB_PROVIDER_PROTOCOL,
    )
  const seen = new Set<string>(),
    sources: WebSearchSource[] = []
  for (const item of x.sources) {
    const s = source(item)
    if (s && !seen.has(s.url)) {
      seen.add(s.url)
      sources.push(s)
    }
  }
  const capped = sources.slice(0, maxResults)
  let content = typeof x.answer === 'string' ? x.answer : undefined
  const truncated = sources.length > capped.length
  let result: WebSearchResult = {
    ...(content === undefined ? {} : { content }),
    sources: capped,
    truncated,
  }
  while (
    JSON.stringify(result).length > maxPayloadBytes &&
    (content || result.sources.length)
  ) {
    if (content) {
      content = content.slice(0, Math.max(0, content.length - 128))
      result = { ...result, content, truncated: true }
    } else {
      result = {
        ...result,
        sources: result.sources.slice(0, -1),
        truncated: true,
      }
    }
  }
  return result
}
function authError(v: unknown): boolean {
  const s = String(v).toLowerCase()
  return /(login required|not logged in|unauthenticated|authentication required|please log in)/.test(
    s,
  )
}
/** Web search provider backed by the official Claude Agent SDK. */
export class ClaudeCodeSearchProvider implements WebSearchProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID
  private readonly active = new Set<AbortController>()
  constructor(
    private readonly ctx: Context,
    private readonly options: ClaudeCodeSearchProviderOptions,
  ) {}
  available(): boolean {
    return (
      this.options.executable === undefined ||
      this.options.executable.trim().length > 0
    )
  }
  async search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const controller = new AbortController()
    this.active.add(controller)
    const abort = () => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort(signal.reason)
    const timer = setTimeout(() => {
      controller.abort('timeout')
    }, this.options.requestTimeoutMs)
    let child: SubprocessHandle | undefined
    let q: Query | undefined
    let primary: unknown
    try {
      let raw = false
      let structured: unknown
      q = (this.options.query ?? officialQuery)({
        prompt:
          'turn exactly one WebSearch call for this query: ' +
          request.query +
          '\nReturn concise grounded answer and sources.',
        options: {
          abortController: controller,
          cwd: this.options.cwd,
          tools: ['WebSearch'],
          allowedTools: ['WebSearch'],
          permissionMode: 'dontAsk',
          persistSession: false,
          maxTurns: this.options.maxTurns,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: { type: 'string' },
                answer: { type: 'string' },
                sources: { type: 'array', items: { type: 'object' } },
              },
              required: ['query', 'sources'],
            },
          },
          spawnClaudeCodeProcess: (spawn: SpawnOptions) => {
            if (child)
              throw new Error(
                'Claude Code SDK attempted more than one process spawn',
              )
            child = this.ctx.subprocess.spawn(
              claudeSpawnSpec(spawn, this.options.disposeGraceMs),
            )
            return new ManagedClaudeCodeProcess(child)
          },
        },
      })
      for await (const message of q) {
        if (message.type === 'user' && message.tool_use_result !== undefined) {
          raw = true
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') {
            if (authError(JSON.stringify(message)))
              throw new WebError(
                unavailable,
                'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
              )
            throw new WebError(
              'Claude Code web search failed',
              WEB_PROVIDER_ERROR,
            )
          }
          structured = message.structured_output
        }
      }
      if (controller.signal.aborted) {
        if (signal?.aborted)
          throw new WebError('web search was cancelled', WEB_ABORTED)
        throw new WebError(
          `Claude Code web search timed out after ${this.options.requestTimeoutMs} ms`,
          WEB_PROVIDER_ERROR,
        )
      }
      if (!raw)
        throw new WebError(
          'Claude Code returned no WebSearch result',
          WEB_PROVIDER_PROTOCOL,
        )
      return normalizeResult(
        structured,
        this.options.maxResults,
        this.options.maxPayloadBytes,
      )
    } catch (error) {
      primary = error
      if (error instanceof WebError) throw error
      if (authError(error))
        throw new WebError(unavailable, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
      if (String(error).includes('ENOENT'))
        throw new WebError(missing, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
      throw new WebError(
        'Claude Code web search provider failed',
        WEB_PROVIDER_ERROR,
        { cause: error },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.active.delete(controller)
      controller.abort()
      try {
        q?.close()
      } catch (cleanup) {
        if (primary === undefined)
          throw new WebError(
            'Claude Code web search cleanup failed',
            WEB_PROVIDER_ERROR,
            { cause: cleanup },
          )
      }
      if (child) child.terminate()
    }
  }
  /** Abort every in-flight search owned by this provider. */
  dispose(): void {
    for (const c of this.active) c.abort('disposed')
  }
}

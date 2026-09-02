import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  query as officialQuery,
  type Query,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  WebError,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { claudeSpawnSpec, ManagedClaudeCodeProcess } from '@deepseek-ai/dsh-subagent-claude-code'

/** Stable registry identifier for this provider. */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
/** Default request deadline in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60000
/** Default process-tree termination grace in milliseconds. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000
/** Default normalized source count. */
export const DEFAULT_MAX_RESULTS = 8
/** Default maximum number of Agent SDK turns. */
export const DEFAULT_MAX_TURNS = 4
/** Default maximum serialized result size in bytes. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 262144
/** Caller cancellation error code. */
export const WEB_ABORTED = 'WEB_ABORTED'
/** Provider execution error code. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'
/** Provider protocol error code. */
export const WEB_PROVIDER_PROTOCOL = 'WEB_PROVIDER_PROTOCOL'
/** Invalid provider configuration error code. */
export const WEB_INVALID_CONFIG = 'WEB_INVALID_CONFIG'

const unavailable = 'Sign in with Claude Code (claude login) and retry; DSH does not read provider credentials'
const missing = 'Claude Code CLI is unavailable; install Claude Code and retry; DSH does not read provider credentials'
const callerAbort = Symbol('caller-abort')
const timeoutAbort = Symbol('timeout-abort')
const disposeAbort = Symbol('dispose-abort')
const sdkEntry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))

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

type ObjectValue = Record<string, unknown>
const classifiedFailures = new WeakSet<WebError>()

function publicFailure(message: string, code: string): WebError {
  const error = new WebError(message, code)
  classifiedFailures.add(error)
  return error
}

interface ActiveSearch {
  readonly abort: () => void
  readonly done: Promise<void>
}

function objectValue(value: unknown): ObjectValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ObjectValue
    : undefined
}

function source(value: unknown): WebSearchSource | undefined {
  const item = objectValue(value)
  if (typeof item?.url !== 'string' || !/^https?:\/\//u.test(item.url)) return undefined
  return {
    url: item.url,
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
    ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}),
    ...(typeof item.publishedAt === 'string' ? { publishedAt: item.publishedAt } : {}),
  }
}

function payloadBytes(value: WebSearchResult): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Normalize structured SDK output into the WebSearchResult contract.
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
  const output = objectValue(value)
  if (
    typeof output?.query !== 'string'
    || !Array.isArray(output.sources)
    || typeof output.truncated !== 'boolean'
    || (output.answer !== undefined && typeof output.answer !== 'string')
  ) {
    throw publicFailure(
      'Claude Code returned malformed structured web search data',
      WEB_PROVIDER_PROTOCOL,
    )
  }
  const seen = new Set<string>()
  const normalized: WebSearchSource[] = []
  for (const value of output.sources) {
    const item = source(value)
    if (item !== undefined && !seen.has(item.url)) {
      seen.add(item.url)
      normalized.push(item)
    }
  }
  let content = output.answer
  let sources = normalized.slice(0, maxResults)
  let truncated = output.truncated || normalized.length > sources.length
  let result: WebSearchResult = {
    ...(content === undefined ? {} : { content }),
    sources,
    truncated,
  }
  while (payloadBytes(result) > maxPayloadBytes && (content !== undefined || sources.length > 0)) {
    if (content !== undefined) {
      const characters = Array.from(content)
      content = characters.length > 128 ? characters.slice(0, -128).join('') : undefined
    } else {
      sources = sources.slice(0, -1)
    }
    truncated = true
    result = {
      ...(content === undefined ? {} : { content }),
      sources,
      truncated,
    }
  }
  return result
}

function stableMarker(value: string): string {
  return value.trim().toLowerCase().replace(/[.!]$/u, '')
}

const authMarkers = new Set([
  'authentication required',
  'login required',
  'not logged in',
  'signed_out',
  'unauthenticated',
  'authentication_required',
  'login_required',
  'not_logged_in',
])

function authError(value: unknown): boolean {
  const error = objectValue(value)
  const direct = [error?.errorClass, error?.code, error?.status, error?.reason, error?.terminal_reason]
  for (const marker of direct) {
    if (typeof marker === 'string' && authMarkers.has(stableMarker(marker))) return true
  }
  if (Array.isArray(error?.errors)) {
    for (const marker of error.errors) {
      if (typeof marker === 'string' && authMarkers.has(stableMarker(marker))) return true
    }
  }
  return value instanceof Error && authMarkers.has(stableMarker(value.message))
}

function missingExecutable(value: unknown): boolean {
  const error = objectValue(value)
  if (error?.code === 'ENOENT' || error?.errorClass === 'executable_not_found') return true
  if (!(value instanceof Error)) return false
  return /^Native CLI binary for [^ ]+ not found\./u.test(value.message)
    || /^Claude Code (?:native binary|executable) (?:at .+ )?not found/u.test(value.message)
}

function rawSources(value: unknown, query: string): WebSearchSource[] | undefined {
  const raw = objectValue(value)
  if (raw?.query !== query || !Array.isArray(raw.results)) return undefined
  const values: unknown[] = []
  for (const result of raw.results) {
    const item = objectValue(result)
    if (Array.isArray(item?.content)) {
      const content: unknown[] = item.content
      values.push(...content)
    } else {
      values.push(result)
    }
  }
  return values.map(source).filter((item): item is WebSearchSource => item !== undefined)
}

function protocol(message: string): WebError {
  return publicFailure(message, WEB_PROVIDER_PROTOCOL)
}

function providerFailure(message: string): WebError {
  return publicFailure(message, WEB_PROVIDER_ERROR)
}

function mapFailure(error: unknown, reason: unknown, timeoutMs: number): WebError {
  if (error instanceof WebError && classifiedFailures.has(error)) return error
  if (reason === callerAbort || reason === disposeAbort) {
    return publicFailure('web search was cancelled', WEB_ABORTED)
  }
  if (reason === timeoutAbort) {
    return providerFailure(`Claude Code web search timed out after ${timeoutMs} ms`)
  }
  if (authError(error)) {
    return publicFailure(unavailable, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
  }
  if (missingExecutable(error)) {
    return publicFailure(missing, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
  }
  return providerFailure('Claude Code web search provider failed')
}

function throwIfAborted(controller: AbortController, timeoutMs: number): void {
  if (controller.signal.aborted) {
    throw mapFailure(undefined, controller.signal.reason, timeoutMs)
  }
}

async function cleanup(
  query: Query | undefined,
  child: SubprocessHandle | undefined,
  primary: WebError | undefined,
): Promise<WebError | undefined> {
  let failure: unknown
  try {
    query?.close()
  } catch (error) {
    failure = error
  }
  if (child !== undefined) {
    try {
      child.terminate()
    } catch (error) {
      failure ??= error
    }
    try {
      if (!await child.waitForExit()) failure ??= new Error('process tree did not exit')
    } catch (error) {
      failure ??= error
    }
    try {
      const outcome: SubprocessOutcome = await child.done
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        failure ??= new Error('Claude Code process exited unsuccessfully')
      }
    } catch (error) {
      failure ??= error
    }
  }
  if (primary !== undefined || failure === undefined) return undefined
  return providerFailure('Claude Code web search cleanup failed')
}

/** Web search provider backed by the official Claude Agent SDK. */
export class ClaudeCodeSearchProvider implements WebSearchProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID
  private readonly active = new Set<ActiveSearch>()
  private readonly query: typeof officialQuery

  constructor(
    private readonly ctx: Context,
    private readonly options: ClaudeCodeSearchProviderOptions,
  ) {
    this.query = options.query ?? officialQuery
  }

  available(): boolean {
    if (this.options.executable === undefined) return existsSync(sdkEntry)
    return isAbsolute(this.options.executable)
      ? existsSync(this.options.executable)
      : this.options.executable.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const active: ActiveSearch = {
      abort: () => { controller.abort(disposeAbort) },
      done,
    }
    this.active.add(active)
    try {
      return await this.execute(request, controller, signal)
    } finally {
      this.active.delete(active)
      finish()
    }
  }

  private async execute(
    request: WebSearchRequest,
    controller: AbortController,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const abort = () => { controller.abort(callerAbort) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => { controller.abort(timeoutAbort) }, this.options.requestTimeoutMs)
    let child: SubprocessHandle | undefined
    let query: Query | undefined
    let primary: WebError | undefined
    let result: WebSearchResult | undefined
    try {
      const cwd = resolve(this.options.cwd)
      if (!statSync(cwd).isDirectory()) {
        throw publicFailure('Claude Code web search cwd is not a directory', WEB_INVALID_CONFIG)
      }
      const executable = this.options.executable === undefined
        ? undefined
        : await this.ctx.subprocess.resolveExecutable(this.options.executable, undefined, controller.signal)
      throwIfAborted(controller, this.options.requestTimeoutMs)
      let rawCount = 0
      let resultCount = 0
      let structured: unknown
      query = this.query({
        prompt: `Use WebSearch exactly once for this query: ${request.query}\nReturn a concise grounded answer and source URLs.`,
        options: {
          abortController: controller,
          cwd,
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
                sources: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      url: { type: 'string' },
                      title: { type: 'string' },
                      snippet: { type: 'string' },
                      publishedAt: { type: 'string' },
                    },
                    required: ['url'],
                  },
                },
                truncated: { type: 'boolean' },
              },
              required: ['query', 'sources', 'truncated'],
            },
          },
          ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
          spawnClaudeCodeProcess: (spawn: SpawnOptions) => {
            throwIfAborted(controller, this.options.requestTimeoutMs)
            if (child !== undefined) throw protocol('Claude Code SDK attempted more than one process spawn')
            const spawned = this.ctx.subprocess.spawn(claudeSpawnSpec(spawn, this.options.disposeGraceMs))
            child = spawned
            throwIfAborted(controller, this.options.requestTimeoutMs)
            return new ManagedClaudeCodeProcess(spawned)
          },
        },
      })
      throwIfAborted(controller, this.options.requestTimeoutMs)
      for await (const message of query) {
        throwIfAborted(controller, this.options.requestTimeoutMs)
        if (message.type === 'user' && message.tool_use_result !== undefined) {
          const sources = rawSources(message.tool_use_result, request.query)
          if (sources !== undefined) {
            if (sources.length === 0) throw protocol('Claude Code returned malformed WebSearch result')
            rawCount += 1
          }
        }
        if (message.type === 'result') {
          resultCount += 1
          if (message.subtype !== 'success') {
            if (authError(message)) {
              throw publicFailure(unavailable, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
            }
            throw providerFailure('Claude Code web search failed')
          }
          structured = message.structured_output
        }
      }
      if (child === undefined) throw protocol('Claude Code SDK did not spawn a process')
      if (rawCount !== 1) {
        throw protocol(rawCount === 0
          ? 'Claude Code returned no WebSearch result'
          : 'Claude Code returned duplicate WebSearch results')
      }
      if (resultCount !== 1) throw protocol('Claude Code returned malformed structured web search data')
      const structuredObject = objectValue(structured)
      if (structuredObject?.query !== request.query) {
        throw protocol('Claude Code returned mismatched structured web search data')
      }
      result = normalizeResult(structured, this.options.maxResults, this.options.maxPayloadBytes)
    } catch (error) {
      primary = mapFailure(error, controller.signal.reason, this.options.requestTimeoutMs)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.abort()
      const cleanupFailure = await cleanup(query, child, primary)
      primary ??= cleanupFailure
    }
    if (primary !== undefined) throw primary
    return result as WebSearchResult
  }

  /** Abort every in-flight search and wait for its process tree cleanup. */
  async dispose(): Promise<void> {
    const active = [...this.active]
    for (const search of active) search.abort()
    await Promise.all(active.map(search => search.done))
  }
}

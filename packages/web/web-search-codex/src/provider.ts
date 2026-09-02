/** Codex CLI subscription-backed web-search provider. */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { CodexProtocolError, CodexSearchWire } from './wire.ts'

/** Stable web-provider id. */
export const CODEX_PROVIDER_ID = 'codex'
/** Caller cancellation error code. */
export const WEB_ABORTED = 'WEB_ABORTED'
/** Runtime/provider failure error code. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'
/** Malformed or incomplete protocol error code. */
export const WEB_PROVIDER_PROTOCOL = 'WEB_PROVIDER_PROTOCOL'
/** Invalid direct configuration error code. */
export const WEB_INVALID_CONFIG = 'WEB_INVALID_CONFIG'
/** Actionable stable authentication failure. */
export const CODEX_AUTH_MESSAGE
  = 'Sign in with the Codex CLI (codex login) and retry; DSH does not read provider credentials'
/** Actionable missing-CLI failure. */
export const CODEX_MISSING_MESSAGE
  = 'Codex CLI is unavailable; install Codex and retry; DSH does not read provider credentials'

/** Fully resolved provider options. */
export interface CodexSearchProviderOptions {
  /** Working directory used for each ephemeral thread. */
  cwd: string
  /** Per-search inner deadline. */
  requestTimeoutMs: number
  /** Process-tree termination grace period. */
  disposeGraceMs: number
  /** Provider-side source cap. */
  maxResults: number
  /** Maximum serialized result and diagnostic bytes. */
  maxPayloadBytes: number
  /** Bare or absolute Codex executable override. */
  executable?: string
}

/** Raw structured data extracted from Codex notifications. */
export interface CodexRawResult {
  sources: readonly Record<string, unknown>[]
  answer?: string
}

class CodexProcessError extends Error {
  constructor(readonly outcome: SubprocessOutcome, readonly diagnostic: string) {
    super('Codex app-server exited before search completion')
  }
}

const require = createRequire(import.meta.url)
const codexManifest = require.resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(codexManifest, 'utf8')) as {
  bin: { codex: string }
}
const codexWrapper = resolve(dirname(codexManifest), codexPackage.bin.codex)

/** One-process-per-search Codex provider. */
export class CodexSearchProvider implements WebSearchProvider {
  readonly id = CODEX_PROVIDER_ID
  private readonly active = new Set<SubprocessHandle>()
  private readonly searches = new Set<AbortController>()

  /** Create a provider backed by the injected subprocess runtime. */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly options: CodexSearchProviderOptions,
  ) {}

  /** Return a synchronous syntax/filesystem availability hint without auth probing. */
  available(): boolean {
    if (!isValidOptions(this.options)) return false
    const executable = this.options.executable
    if (executable === undefined) return existsSync(codexWrapper)
    return isAbsolute(executable) ? existsSync(executable) : true
  }

  /** Abort every in-flight search and await complete process-tree quiescence. */
  async dispose(): Promise<void> {
    for (const controller of this.searches) controller.abort(new Error('Codex provider disposed'))
    for (const child of this.active) child.terminate()
    await Promise.all([...this.active].map(async child => await child.waitForExit().catch(() => false)))
  }

  /** Execute one live Codex web-search turn. */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (!isValidOptions(this.options)) {
      throw new WebError('invalid Codex provider configuration', WEB_INVALID_CONFIG)
    }
    if (isAborted(signal)) throw abortedError(signal?.reason)

    const cwd = resolveDirectory(this.options.cwd)
    const controller = new AbortController()
    this.searches.add(controller)
    const timeoutReason = new Error('Codex search timeout')
    const timer = setTimeout(() => {
      controller.abort(timeoutReason)
    }, this.options.requestTimeoutMs)
    const onAbort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })

    let child: SubprocessHandle | undefined
    let wire: CodexSearchWire | undefined
    let primaryError: unknown
    try {
      const configured = this.options.executable
      let executable: string
      try {
        executable = await this.subprocess.resolveExecutable(
          configured ?? codexWrapper,
          undefined,
          controller.signal,
        )
      } catch (error: unknown) {
        if (isAborted(signal)) throw abortedError(error)
        if (controller.signal.reason === timeoutReason) throw timeoutError(this.options.requestTimeoutMs, error)
        throw new WebError(CODEX_MISSING_MESSAGE, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', { cause: error })
      }

      const argv = configured === undefined
        ? [process.execPath, executable, 'app-server', '--stdio']
        : [executable, 'app-server', '--stdio']
      child = this.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: this.options.maxPayloadBytes },
        },
        graceMs: this.options.disposeGraceMs,
        signal: controller.signal,
      })
      this.active.add(child)
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('Codex app-server did not expose required protocol pipes')
      }

      wire = new CodexSearchWire(child.stdout, child.stdin)
      wire.start()
      await raceChild(wire.initialize(controller.signal), child)
      await raceChild(wire.startThread(cwd, controller.signal), child)
      const turn = await raceChild(wire.runTurn(request.query, controller.signal), child)
      return structuredResult(turn.items, this.options.maxResults, this.options.maxPayloadBytes)
    } catch (error: unknown) {
      primaryError = error
      if (isAborted(signal)) throw abortedError(error)
      if (controller.signal.reason === timeoutReason) throw timeoutError(this.options.requestTimeoutMs, error)
      if (error instanceof WebError) throw error
      if (error instanceof CodexProtocolError) {
        throw new WebError('Codex returned invalid web search protocol data', WEB_PROVIDER_PROTOCOL, { cause: error })
      }
      if (isAuthEvidence(error)) {
        throw new WebError(CODEX_AUTH_MESSAGE, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', { cause: error })
      }
      throw new WebError('Codex web search failed', WEB_PROVIDER_ERROR, { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      let cleanupError: unknown
      try {
        wire?.interrupt()
        wire?.close()
        child?.stdin?.end()
        child?.terminate()
        if (child !== undefined) {
          await child.waitForExit()
          await child.done
        }
      } catch (error: unknown) {
        cleanupError = error
      } finally {
        if (child !== undefined) this.active.delete(child)
        this.searches.delete(controller)
      }
      if (primaryError === undefined && cleanupError !== undefined) {
        throw new WebError('Codex web search cleanup failed', WEB_PROVIDER_ERROR, { cause: cleanupError })
      }
    }
  }
}

function resolveDirectory(value: string): string {
  try {
    const cwd = resolve(value)
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
    return cwd
  } catch (cause: unknown) {
    throw new WebError('invalid Codex provider configuration', WEB_INVALID_CONFIG, { cause })
  }
}

function isSafeInteger(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max
}

function isExecutable(value: string): boolean {
  return value.trim().length > 0 && (isAbsolute(value) || !/[\\/]/u.test(value))
}

function isValidOptions(options: CodexSearchProviderOptions): boolean {
  return options.cwd.trim().length > 0
    && isSafeInteger(options.requestTimeoutMs, 1, 600_000)
    && isSafeInteger(options.disposeGraceMs, 1, 60_000)
    && isSafeInteger(options.maxResults, 1, 50)
    && isSafeInteger(options.maxPayloadBytes, 1_048, 1_048_576)
    && (options.executable === undefined || isExecutable(options.executable))
}

function diagnosticOf(child: SubprocessHandle): string {
  return child.collected.stderr?.readFrom(0).text.slice(-4_096) ?? ''
}

async function raceChild<T>(pending: Promise<T>, child: SubprocessHandle): Promise<T> {
  const exited = child.done.then((outcome) => {
    throw new CodexProcessError(outcome, diagnosticOf(child))
  })
  return await Promise.race([pending, exited])
}

function isAuthEvidence(error: unknown): boolean {
  if (!(error instanceof CodexProcessError)) return false
  if (error.outcome.exitCode === 0) return false
  return /(?:login required|authentication required|not authenticated|run codex login)/iu.test(error.diagnostic)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortedError(cause: unknown): WebError {
  return new WebError('Codex web search aborted', WEB_ABORTED, { cause })
}

function timeoutError(milliseconds: number, cause: unknown): WebError {
  return new WebError(`Codex web search timed out after ${milliseconds} ms`, WEB_PROVIDER_ERROR, { cause })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isHttpUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'http:' || new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function serializedBytes(sources: readonly WebSearchSource[], content?: string): number {
  return Buffer.byteLength(JSON.stringify({ sources, ...(content === undefined ? {} : { content }) }))
}

function structuredResult(
  items: readonly Record<string, unknown>[],
  maxResults: number,
  maxPayloadBytes: number,
): WebSearchResult {
  const searches = items.filter(item => item.type === 'webSearch')
  const search = searches[0]
  if (searches.length !== 1 || search === undefined || typeof search.query !== 'string'
    || !Array.isArray(search.results)) {
    throw new CodexProtocolError('Codex returned incomplete structured web search data')
  }
  const sources = search.results.filter(isObject)
  if (sources.length === 0) {
    throw new CodexProtocolError('Codex returned incomplete structured web search data')
  }
  const message = items.find(item => item.type === 'agentMessage' && typeof item.final_answer === 'string')
  return normalizeCodexResult({
    sources,
    ...(typeof message?.final_answer === 'string' ? { answer: message.final_answer } : {}),
  }, maxResults, maxPayloadBytes)
}

/**
 * Normalize URLs, optional fields, deduplication, ordering, and payload caps.
 * @param result - Structured source and answer data extracted from Codex.
 * @param maxResults - Maximum retained unique HTTP(S) sources.
 * @param maxPayloadBytes - Maximum serialized result size in bytes.
 * @returns A bounded provider-neutral Web search result.
 */
export function normalizeCodexResult(
  result: CodexRawResult,
  maxResults: number,
  maxPayloadBytes: number,
): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  let truncated = false
  for (const source of result.sources) {
    if (typeof source.url !== 'string' || !isHttpUrl(source.url) || seen.has(source.url)) {
      continue
    }
    seen.add(source.url)
    if (sources.length === maxResults) {
      truncated = true
      continue
    }
    const publishedAt = typeof source.publishedAt === 'string' && source.publishedAt.length > 0
      ? source.publishedAt
      : typeof source.published_at === 'string' && source.published_at.length > 0
        ? source.published_at
        : typeof source.page_age === 'string' && source.page_age.length > 0
          ? source.page_age
          : undefined
    sources.push({
      url: source.url,
      ...(typeof source.title === 'string' && source.title.length > 0 ? { title: source.title } : {}),
      ...(typeof source.snippet === 'string' && source.snippet.length > 0 ? { snippet: source.snippet } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }

  let content = result.answer
  while (serializedBytes(sources, content) > maxPayloadBytes) {
    truncated = true
    if (content !== undefined && content.length > 0) {
      content = content.slice(0, Math.max(0, content.length - 256))
      if (content.length === 0) content = undefined
    } else if (sources.length > 0) {
      sources.pop()
    } else {
      break
    }
  }
  return { sources, truncated, ...(content === undefined ? {} : { content }) }
}

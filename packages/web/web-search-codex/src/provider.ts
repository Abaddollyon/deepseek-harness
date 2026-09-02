/** Official Codex app-server implementation of subscription-native batched web search. */

import process from 'node:process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
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
import { CodexSearchWire } from './wire.ts'

/** Stable provider id selected by web runtime config. */
export const CODEX_SEARCH_PROVIDER_ID = 'codex'
/** Default managed process-tree termination grace. */
export const DEFAULT_CODEX_SEARCH_GRACE_MS = 3_000

type JsonObject = Record<string, unknown>

interface CodexPackageManifest {
  readonly bin: { readonly codex: string }
}

const codexPackageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackageManifest = JSON.parse(readFileSync(codexPackageJsonPath, 'utf8')) as CodexPackageManifest
const CODEX_PACKAGE_BIN = resolve(dirname(codexPackageJsonPath), codexPackageManifest.bin.codex)

/** Validated runtime options for one Codex search provider. */
export interface CodexSearchProviderOptions {
  readonly cwd: string
  readonly graceMs: number
}

function codexAppServerArgv(): string[] {
  return [process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function protocolFailure(query: string): WebSearchBatchOutcome {
  return {
    query,
    error: {
      code: 'WEB_PROVIDER_PROTOCOL',
      message: 'Codex returned incomplete structured web search data',
    },
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseSource(value: unknown): WebSearchSource | undefined {
  const candidate = record(value)
  const url = optionalString(candidate?.url)
  if (url === undefined) return undefined
  const title = optionalString(candidate?.title)
  const snippet = optionalString(candidate?.snippet)
  const publishedAt = optionalString(candidate?.publishedAt) ?? optionalString(candidate?.published_at)
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

function parseItems(
  items: readonly JsonObject[],
  request: WebSearchBatchRequest,
): ReadonlyMap<string, WebSearchBatchOutcome> {
  const expected = new Set(request.queries)
  const byQuery = new Map<string, JsonObject[]>()
  for (const item of items) {
    if (typeof item.query !== 'string' || !expected.has(item.query)) continue
    byQuery.set(item.query, [...byQuery.get(item.query) ?? [], item])
  }
  const outcomes = new Map<string, WebSearchBatchOutcome>()
  for (const query of expected) {
    const matches = byQuery.get(query)
    if (matches?.length !== 1 || !Array.isArray(matches[0]?.results)) {
      outcomes.set(query, protocolFailure(query))
      continue
    }
    const sources = filterWebSearchSourcesByDomains(
      matches[0].results.map(parseSource).filter((source): source is WebSearchSource => source !== undefined),
      request,
    )
    outcomes.set(query, { query, result: { sources, truncated: false } })
  }
  return outcomes
}

function dispose(wire: CodexSearchWire | undefined, child: SubprocessHandle | undefined): Promise<void> {
  return disposeManagedSubprocess(child, () => {
    wire?.close()
    child?.stdin?.end()
  }, 'Codex web search teardown failed')
}

/** Official subscription-native Codex app-server search provider. */
export class CodexSearchProvider extends NativeBatchSearchProvider {
  readonly id = CODEX_SEARCH_PROVIDER_ID

  constructor(
    private readonly ctx: Context,
    private readonly options: CodexSearchProviderOptions,
  ) {
    super()
  }

  /** Run every distinct query in one official app-server process, thread, and turn. */
  async searchMany(
    request: WebSearchBatchRequest,
    signal?: AbortSignal,
  ): Promise<readonly WebSearchBatchOutcome[]> {
    const abortScope = createNativeProviderAbortScope(signal)
    const { controller } = abortScope
    const providerRequest = { ...request, queries: [...new Set(request.queries)] }
    let child: SubprocessHandle | undefined
    let wire: CodexSearchWire | undefined
    let primaryFailure: unknown
    try {
      child = this.ctx.subprocess.spawn({
        argv: codexAppServerArgv(),
        cwd: this.options.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.options.graceMs,
      })
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('Codex app-server did not expose required protocol pipes')
      }
      const activeWire = new CodexSearchWire(child.stdout, child.stdin)
      wire = activeWire
      activeWire.start()
      const processFailure = child.done.then<never>(
        outcome => Promise.reject(new Error(`Codex app-server exited before search completed (${String(outcome.exitCode)})`)),
        (error: unknown) => Promise.reject(new Error('Codex app-server process failed', { cause: error })),
      )
      const run = async (): Promise<ReadonlyMap<string, WebSearchBatchOutcome>> => {
        await activeWire.initialize(controller.signal)
        await activeWire.startThread(this.options.cwd, providerRequest, controller.signal)
        const turn = await activeWire.runTurn(providerRequest, controller.signal)
        return parseItems(turn.items, providerRequest)
      }
      const mapped = await Promise.race([run(), processFailure])
      return request.queries.map((query) => {
        const outcome = mapped.get(query)
        /* v8 ignore next -- parseItems covers every distinct provider query. */
        return outcome ?? protocolFailure(query)
      })
    } catch (error: unknown) {
      primaryFailure = error
      if (controller.signal.aborted) {
        wire?.interrupt()
        throw new WebError('web search was cancelled', 'WEB_ABORTED', { cause: signal?.reason })
      }
      throw new WebError('Codex web search provider failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      abortScope.dispose()
      controller.abort('Codex web search completed')
      try {
        await dispose(wire, child)
      } catch (cleanupError: unknown) {
        if (primaryFailure === undefined) {
          throw new WebError('Codex web search cleanup failed', 'WEB_PROVIDER_ERROR', { cause: cleanupError })
        }
      }
    }
  }
}

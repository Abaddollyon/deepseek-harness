import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SubprocessRuntime, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { CodexSearchWire } from './wire.ts'

export const CODEX_PROVIDER_ID = 'codex'
export const WEB_ABORTED = 'WEB_ABORTED'
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'
export const WEB_PROVIDER_PROTOCOL = 'WEB_PROVIDER_PROTOCOL'
export const WEB_INVALID_CONFIG = 'WEB_INVALID_CONFIG'
export const CODEX_AUTH_MESSAGE = 'Sign in with the Codex CLI (codex login) and retry; DSH does not read provider credentials'
export const CODEX_MISSING_MESSAGE = 'Codex CLI is unavailable; install Codex and retry; DSH does not read provider credentials'

export interface CodexSearchProviderOptions {
  cwd: string
  requestTimeoutMs: number
  disposeGraceMs: number
  maxResults: number
  maxPayloadBytes: number
  executable?: string
}

export class CodexSearchProvider implements WebSearchProvider {
  readonly id = CODEX_PROVIDER_ID
  private readonly active = new Set<SubprocessHandle>()
  constructor(private readonly subprocess: SubprocessRuntime, private readonly options: CodexSearchProviderOptions) {}
  available(): boolean {
    return valid(this.options) && (this.options.executable !== undefined || existsSync(wrapperPath()))
  }
  async dispose(): Promise<void> {
    for (const child of this.active) child.terminate()
    await Promise.all([...this.active].map(child => child.waitForExit().catch(() => false)))
  }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (!valid(this.options)) throw new WebError('invalid Codex provider configuration', WEB_INVALID_CONFIG)
    if (signal?.aborted) throw new WebError('Codex web search aborted', WEB_ABORTED)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('timeout'), this.options.requestTimeoutMs)
    const onAbort = (): void => controller.abort(signal?.reason ?? 'aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    let child: SubprocessHandle | undefined
    let wire: CodexSearchWire | undefined
    try {
      const executable = this.options.executable ?? await this.subprocess.resolveExecutable(wrapperPath(), undefined, controller.signal)
      const argv = this.options.executable === undefined
        ? [process.execPath, executable, 'app-server', '--stdio']
        : [this.options.executable, 'app-server', '--stdio']
      child = this.subprocess.spawn({ argv, cwd: this.options.cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.options.maxPayloadBytes } }, graceMs: this.options.disposeGraceMs, signal: controller.signal })
      this.active.add(child)
      if (child.stdin === undefined || child.stdout === undefined) throw new Error('Codex process pipes unavailable')
      wire = new CodexSearchWire(child.stdout, child.stdin)
      wire.start()
      await wire.initialize(controller.signal)
      await wire.startThread(this.options.cwd, controller.signal)
      const turn = await wire.runTurn(request.query, controller.signal)
      const sources = turn.items.flatMap(item => Array.isArray(item.results) ? item.results.filter(isObject) : [])
      const message = turn.items.find(item => item.type === 'agentMessage' && typeof item.final_answer === 'string')
      await child.done
      return normalizeCodexResult({ sources, answer: typeof message?.final_answer === 'string' ? message.final_answer : undefined }, this.options.maxResults, this.options.maxPayloadBytes)
    } catch (error: unknown) {
      if (signal?.aborted) throw new WebError('Codex web search aborted', WEB_ABORTED, { cause: error })
      if (controller.signal.aborted) throw new WebError('Codex web search timed out after ' + this.options.requestTimeoutMs + ' ms', WEB_PROVIDER_ERROR, { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError('Codex web search failed', WEB_PROVIDER_ERROR, { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      wire?.interrupt()
      wire?.close()
      child?.terminate()
      if (child !== undefined) await child.waitForExit().catch(() => false)
      if (child !== undefined) this.active.delete(child)
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function valid(options: CodexSearchProviderOptions): boolean {
  return options.cwd.trim() !== '' && [options.requestTimeoutMs, options.disposeGraceMs, options.maxResults, options.maxPayloadBytes].every(Number.isSafeInteger) && options.requestTimeoutMs > 0 && options.disposeGraceMs > 0 && options.maxResults > 0 && options.maxResults <= 50 && options.maxPayloadBytes >= 1048 && options.maxPayloadBytes <= 1048576
}
function wrapperPath(): string {
  const candidates = ['../../../../node_modules/@openai/codex/bin/codex.js', '../../../node_modules/@openai/codex/bin/codex.js'].map(path => fileURLToPath(new URL(path, import.meta.url)))
  return candidates.find(path => existsSync(path)) ?? candidates[0] ?? 'codex'
}
export function normalizeCodexResult(result: { sources: Record<string, unknown>[]; answer?: string }, maxResults: number, maxPayloadBytes: number): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const source of result.sources) {
    if (typeof source.url !== 'string' || !URL.canParse(source.url) || !/^https?:$/.test(new URL(source.url).protocol) || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push({ url: source.url, ...(typeof source.title === 'string' && source.title ? { title: source.title } : {}), ...(typeof source.snippet === 'string' && source.snippet ? { snippet: source.snippet } : {}), ...(typeof source.publishedAt === 'string' && source.publishedAt ? { publishedAt: source.publishedAt } : {}) })
  }
  let truncated = sources.length > maxResults
  sources.splice(maxResults)
  let content = result.answer
  while (JSON.stringify({ content, sources }).length > maxPayloadBytes) {
    truncated = true
    if (content !== undefined && content.length > 0) content = content.slice(0, Math.max(0, content.length - 256))
    else sources.pop()
  }
  return { sources, truncated, ...(content ? { content } : {}) }
}
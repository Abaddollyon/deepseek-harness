import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
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

export interface CodexSearchProviderOptions { cwd: string; requestTimeoutMs: number; disposeGraceMs: number; maxResults: number; maxPayloadBytes: number; executable?: string }

interface RawResult { sources: Record<string, unknown>[]; answer?: string }
const codexBin = (() => { try { const manifest = JSON.parse(createRequire(import.meta.url).resolve('@openai/codex/package.json')) as { bin?: { codex?: string } }; return resolve(dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')), manifest.bin?.codex ?? 'bin/codex.js') } catch { return resolve(dirname(new URL('.', import.meta.url).pathname), '../../../../node_modules/@openai/codex/bin/codex.js') } })()

export class CodexSearchProvider implements WebSearchProvider {
  readonly id = CODEX_PROVIDER_ID
  private readonly active = new Set<SubprocessHandle>()
  constructor(private readonly subprocess: SubprocessRuntime, private readonly options: CodexSearchProviderOptions) {}
  available(): boolean { return valid(this.options) && (this.options.executable === undefined ? existsSync(codexBin) : isExecutable(this.options.executable)) }
  async dispose(): Promise<void> { for (const child of this.active) child.terminate(); await Promise.all([...this.active].map(child => child.waitForExit().catch(() => false))) }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (!valid(this.options)) throw new WebError('invalid Codex provider configuration', WEB_INVALID_CONFIG)
    if (signal?.aborted) throw new WebError('Codex web search aborted', WEB_ABORTED)
    let cwd: string
    try { cwd = resolve(this.options.cwd); if (!statSync(cwd).isDirectory()) throw new Error('not a directory') } catch (cause) { throw new WebError('invalid Codex provider configuration', WEB_INVALID_CONFIG, { cause }) }
    const controller = new AbortController(); let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort('timeout') }, this.options.requestTimeoutMs)
    const onAbort = (): void =>{  controller.abort(signal?.reason ?? 'aborted'); }; signal?.addEventListener('abort', onAbort, { once: true })
    let child: SubprocessHandle | undefined; let wire: CodexSearchWire | undefined; let primary: unknown; let resolving = true
    try {
      const executable = this.options.executable ?? await this.subprocess.resolveExecutable(codexBin, undefined, controller.signal)
      resolving = false
      const argv = this.options.executable === undefined ? [process.execPath, executable, 'app-server', '--stdio'] : [executable, 'app-server', '--stdio']
      child = this.subprocess.spawn({ argv, cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.options.maxPayloadBytes } }, graceMs: this.options.disposeGraceMs, signal: controller.signal }); this.active.add(child)
      if (!child.stdin || !child.stdout) throw new Error('Codex app-server did not expose required protocol pipes')
      wire = new CodexSearchWire(child.stdout, child.stdin); wire.start()
      await wire.initialize(controller.signal); await wire.startThread(cwd, controller.signal); const turn = await wire.runTurn(request.query, controller.signal)
      const webItems = turn.items.filter(item => item.type === 'webSearch')
      if (webItems.length !== 1 || !Array.isArray(webItems[0]?.results) || typeof webItems[0]?.query !== 'string') throw new WebError('Codex returned incomplete structured web search data', WEB_PROVIDER_PROTOCOL)
      const message = turn.items.find(item => item.type === 'agentMessage' && typeof item.final_answer === 'string')
      const sources = webItems[0].results.filter(isObject)
      if (sources.length === 0) throw new WebError('Codex returned incomplete structured web search data', WEB_PROVIDER_PROTOCOL)
      return normalizeCodexResult({ sources, ...(typeof message?.final_answer === 'string' ? { answer: message.final_answer } : {}) }, this.options.maxResults, this.options.maxPayloadBytes)
    } catch (error) { primary = error; if (signal?.aborted) throw new WebError('Codex web search aborted', WEB_ABORTED, { cause: error }); if (timedOut) throw new WebError('Codex web search timed out after ' + this.options.requestTimeoutMs + ' ms', WEB_PROVIDER_ERROR, { cause: error }); if (error instanceof WebError) throw error; if (resolving) throw new WebError(CODEX_MISSING_MESSAGE, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', { cause: error }); if (isAuthEvidence(error)) throw new WebError(CODEX_AUTH_MESSAGE, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', { cause: error }); throw new WebError('Codex web search failed', WEB_PROVIDER_ERROR, { cause: error })
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); wire?.interrupt(); wire?.close(); child?.terminate(); if (child) await child.waitForExit().catch(() => false); if (child) this.active.delete(child); void primary }
  }
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isInteger(value: number, min: number, max: number): boolean { return Number.isSafeInteger(value) && value >= min && value <= max }
function valid(o: CodexSearchProviderOptions): boolean { return typeof o.cwd === 'string' && o.cwd.trim() !== '' && isInteger(o.requestTimeoutMs, 1, 600000) && isInteger(o.disposeGraceMs, 1, 60000) && isInteger(o.maxResults, 1, 50) && isInteger(o.maxPayloadBytes, 1048, 1048576) && (o.executable === undefined || isExecutable(o.executable)) }
function isExecutable(value: string): boolean { return value.trim() !== '' && (value.startsWith('/') || !/[\\/]/.test(value)) }
function isAuthEvidence(error: unknown): boolean { const text = error instanceof Error ? error.message.toLowerCase() : ''; return /\b(login required|authentication required|not authenticated|codex login)\b/.test(text) }
function isHttpUrl(value: string): boolean { try { return /^https?:$/.test(new URL(value).protocol) } catch { return false } }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)) }
export function normalizeCodexResult(result: RawResult, maxResults: number, maxPayloadBytes: number): WebSearchResult {
  const seen = new Set<string>(); const sources: WebSearchSource[] = []
  for (const source of result.sources) { if (typeof source.url !== 'string' || !isHttpUrl(source.url) || seen.has(source.url)) continue; seen.add(source.url); sources.push({ url: source.url, ...(typeof source.title === 'string' && source.title ? { title: source.title } : {}), ...(typeof source.snippet === 'string' && source.snippet ? { snippet: source.snippet } : {}), ...(typeof source.publishedAt === 'string' && source.publishedAt ? { publishedAt: source.publishedAt } : typeof source.published_at === 'string' && source.published_at ? { publishedAt: source.published_at } : {}) }) }
  let truncated = sources.length > maxResults; sources.splice(maxResults); let content = result.answer
  while (byteLength({ sources, ...(content ? { content } : {}) }) > maxPayloadBytes) { truncated = true; if (content) content = content.slice(0, Math.max(0, content.length - 256)); else sources.pop() }
  return { sources, truncated, ...(content ? { content } : {}) }
}

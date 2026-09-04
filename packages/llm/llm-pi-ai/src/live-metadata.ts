/** Bounded provider-specific model metadata; remote prompts and instructions are never retained.
 * @module dsh-llm-pi-ai/live-metadata
 */
import type { ModelAuth } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { catalogProvider, THINKING_LEVELS } from './catalog.ts'
import type { PiAiModelProfile, PiAiReasoningEfforts } from './catalog.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 2000
const MAX_PAGES = 10
const STABLE_VERSION = /^\d+\.\d+\.\d+$/

/** Sanitized metadata fetch result and the public Codex client version, when used. */
export interface LiveMetadata {
  models: PiAiModelProfile[]
  clientVersion?: string
}

function failed(): LlmError {
  return new LlmError('model discovery failed: unavailable, incomplete, or invalid provider metadata', 'DISCOVERY_FAILED')
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failed()
  return value as Record<string, unknown>
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined
}

/** Normalize a complete provider page, filtering unsupported Codex entries and effort levels.
 * @param rows - Untrusted provider model rows.
 * @param codex - Whether rows use Codex's catalog fields.
 * @returns Metadata suitable for configuration resolution and disk persistence.
 */
export function normalizeMetadata(rows: unknown, codex = false): PiAiModelProfile[] {
  if (!Array.isArray(rows) || rows.length > MAX_ENTRIES) throw failed()
  return rows.flatMap((raw): PiAiModelProfile[] => {
    const row = object(raw)
    if (codex && (row['visibility'] !== 'list' || row['supported_in_api'] === false)) return []
    const id = label(codex ? row['slug'] : row['id'])
    if (id === undefined) throw failed()
    const name = label(row['display_name'] ?? row['name'])
    if (row['type'] !== undefined && row['type'] !== 'model') throw failed()
    const contextWindow = positive(row['context_window'] ?? row['max_context_window'] ?? row['context_length'] ?? row['max_input_tokens'])
    const maxTokens = positive(row['max_output_tokens'] ?? row['max_tokens'])
    const capabilities = row['capabilities'] === undefined || row['capabilities'] === null ? {} : object(row['capabilities'])
    const effort = capabilities['effort'] === undefined ? undefined : object(capabilities['effort'])
    const supported = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as { supported?: unknown }).supported === true
    const effortLevels = effort === undefined ? undefined : THINKING_LEVELS.filter(level => supported(effort[level]))
    const rawEfforts = row['supported_reasoning_levels'] ?? row['think_efforts'] ?? effortLevels
    const reasoningEfforts: PiAiReasoningEfforts = {}
    if (Array.isArray(rawEfforts)) {
      for (const item of rawEfforts) {
        const level = typeof item === 'string' ? item : object(item)['effort']
        if (typeof level === 'string' && THINKING_LEVELS.includes(level as typeof THINKING_LEVELS[number])) {
          reasoningEfforts[level as typeof THINKING_LEVELS[number]] = level === 'off' ? null : level
        }
      }
    }
    const modalities = row['input_modalities']
    const vision = row['supports_image_in'] ?? (capabilities['image_input'] === undefined ? undefined : supported(capabilities['image_input']))
    const input: Array<'text' | 'image'> | undefined = Array.isArray(modalities)
      ? modalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
      : vision === undefined ? undefined : vision === true ? ['text', 'image'] : ['text']
    return [{
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...input === undefined || input.length === 0 ? {} : { input },
      ...rawEfforts === undefined ? {} : { reasoningEfforts: Object.keys(reasoningEfforts).length > 0 ? reasoningEfforts : false },
      ...row['supports_reasoning'] === false || capabilities['thinking'] !== undefined && !supported(capabilities['thinking']) ? { reasoningEfforts: false } : {},
    }]
  })
}

/** Fetch authenticated metadata within one caller-owned deadline and aggregate byte budget.
 * @param profile - Frozen configured provider route.
 * @param auth - Request auth resolved by pi-ai's serialized credential service.
 * @param signal - Total refresh cancellation, including body reads.
 * @param previousVersion - Last successful public Codex version for offline metadata fallback.
 * @returns A complete, nonempty normalized catalog.
 */
export async function fetchLiveMetadata(
  profile: ResolvedPiAiProviderProfile,
  auth: ModelAuth,
  signal: AbortSignal,
  previousVersion?: string,
): Promise<LiveMetadata> {
  let remaining = MAX_BYTES
  async function read(url: URL, headers: Headers, requestSignal = signal): Promise<Record<string, unknown>> {
    requestSignal.throwIfAborted()
    const response = await fetch(url, { headers, signal: requestSignal, redirect: 'error' })
    if (!response.ok) {
      await response.body?.cancel()
      throw failed()
    }
    if (Number(response.headers.get('content-length')) > remaining) {
      await response.body?.cancel()
      throw failed()
    }
    if (response.body === null) throw failed()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    const abort = (): void => { void reader.cancel().catch(() => { /* The request is already aborted. */ }) }
    requestSignal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        requestSignal.throwIfAborted()
        const { done, value } = await reader.read()
        requestSignal.throwIfAborted()
        if (done) break
        remaining -= value.byteLength
        if (remaining < 0) throw failed()
        chunks.push(value)
        total += value.byteLength
      }
    } finally {
      requestSignal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => { /* Completed or rejected reads need no further body data. */ })
    }
    return object(JSON.parse(Buffer.concat(chunks, total).toString('utf8')))
  }
  const headers = new Headers(profile.headers)
  for (const [key, value] of Object.entries(auth.headers ?? {})) if (value !== null) headers.set(key, value)
  headers.set('accept', 'application/json')
  const provider = profile.provider
  if (auth.apiKey !== undefined) headers.set('authorization', `Bearer ${auth.apiKey}`)
  let base = profile.baseURL ?? auth.baseUrl ?? catalogProvider(provider)?.baseUrl
  if (base === undefined) throw failed()
  base = base.replace(/\/+$/, '')
  let url: URL
  let clientVersion: string | undefined
  if (provider === 'openai-codex') {
    clientVersion = previousVersion
    const publicTimeout = new AbortController()
    const publicTimer = setTimeout(() =>{  publicTimeout.abort() }, Math.min(3000, (profile.modelDiscovery?.timeoutMs ?? 15000) / 3))
    try {
      const latest = await read(new URL('https://registry.npmjs.org/@openai%2Fcodex/latest'), new Headers({ accept: 'application/json' }), AbortSignal.any([signal, publicTimeout.signal]))
      if (typeof latest['version'] === 'string' && STABLE_VERSION.test(latest['version'])) clientVersion = latest['version']
    } catch {
      // Public version lookup may be offline; only a previously successful version is reusable.
    } finally {
      clearTimeout(publicTimer)
    }
    if (clientVersion === undefined || !STABLE_VERSION.test(clientVersion)) throw failed()
    url = new URL(`${base.endsWith('/codex') ? base : `${base}/codex`}/models`)
    url.searchParams.set('client_version', clientVersion)
    headers.set('originator', 'pi')
    if (!headers.has('chatgpt-account-id') && auth.apiKey !== undefined) {
      try {
        const payload = object(JSON.parse(Buffer.from(auth.apiKey.split('.')[1] ?? '', 'base64url').toString('utf8')))
        const account = object(payload['https://api.openai.com/auth'])['chatgpt_account_id']
        if (typeof account === 'string') headers.set('ChatGPT-Account-Id', account)
      } catch {
        // A malformed provider token cannot supply a required account header.
      }
    }
    if (!headers.has('chatgpt-account-id')) throw failed()
  } else {
    const prefix = provider === 'kimi-coding' || provider === 'anthropic'
      ? base.endsWith('/v1') ? base : `${base}/v1`
      : base
    url = new URL(`${prefix}/models`)
    if (provider === 'anthropic') {
      headers.set('anthropic-version', '2023-06-01')
      if (auth.apiKey?.startsWith('sk-ant-oat') === true) headers.set('anthropic-beta', 'oauth-2025-04-20')
      else if (auth.apiKey !== undefined) {
        headers.delete('authorization')
        headers.set('x-api-key', auth.apiKey)
      }
      url.searchParams.set('limit', '1000')
    }
  }
  const models = new Map<string, PiAiModelProfile>()
  const cursors = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await read(url, headers)
    for (const model of normalizeMetadata(provider === 'openai-codex' ? body['models'] : body['data'], provider === 'openai-codex')) {
      models.set(model.id, model)
    }
    if (models.size > MAX_ENTRIES) throw failed()
    if (body['has_more'] !== true) {
      if (models.size === 0) throw failed()
      return { models: [...models.values()], ...clientVersion === undefined ? {} : { clientVersion } }
    }
    const cursor = label(body['last_id'])
    if (cursor === undefined || cursors.has(cursor)) throw failed()
    cursors.add(cursor)
    url.searchParams.set('after_id', cursor)
  }
  throw failed()
}

/** Claude Code subscription-backed web search provider plugin. */
import process from 'node:process'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  ClaudeCodeSearchProvider,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  WEB_INVALID_CONFIG,
} from './provider.ts'

export {
  normalizeResult,
  ClaudeCodeSearchProvider,
  CLAUDE_CODE_PROVIDER_ID,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  WEB_ABORTED,
  WEB_PROVIDER_ERROR,
  WEB_PROVIDER_PROTOCOL,
  WEB_INVALID_CONFIG,
} from './provider.ts'
export type { ClaudeCodeSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-claude-code'
/** Hard service dependencies for this plugin. */
export const inject = ['web', 'subprocess']

/** Configuration for the Claude Code web-search plugin. */
export interface Config {
  /** Working directory used for Claude Code searches. */
  cwd?: string
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number
  /** Process-tree termination grace in milliseconds. */
  disposeGraceMs?: number
  /** Maximum normalized source count. */
  maxResults?: number
  /** Maximum SDK turns per query. */
  maxTurns?: number
  /** Maximum normalized payload bytes. */
  maxPayloadBytes?: number
  /** Optional absolute or bare Claude executable override. */
  executable?: string
  /** Provider IDs are fixed and cannot be overridden. */
  id?: never
}

export const Config: z<Config> = z.object({
  cwd: z.string().min(1),
  requestTimeoutMs: z.number().step(1).min(1).max(600000),
  disposeGraceMs: z.number().step(1).min(1).max(60000),
  maxResults: z.number().step(1).min(1).max(50),
  maxTurns: z.number().step(1).min(1).max(16),
  maxPayloadBytes: z.number().step(1).min(1048).max(1048576),
  executable: z.string().min(1),
})

function invalid(message: string): never {
  throw new WebError(`Invalid Claude Code web search config: ${message}`, WEB_INVALID_CONFIG)
}

function safeInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${name} must be a safe integer from ${minimum} to ${maximum}`)
  }
  return value
}

/** Register one fixed-ID Claude Code search provider with ctx.web. */
export function apply(ctx: Context, config: Config = {}): void {
  if (Object.hasOwn(config, 'id')) invalid('id cannot be overridden')
  const cwd = config.cwd ?? process.cwd()
  if (cwd.trim().length === 0) invalid('cwd must be nonblank')
  const executable = config.executable
  if (
    executable !== undefined
    && (executable.trim() !== executable
      || executable.length === 0
      || (!isAbsolute(executable) && /[\\/]/u.test(executable)))
  ) {
    invalid('executable must be a nonblank bare name or absolute path')
  }
  const provider = new ClaudeCodeSearchProvider(ctx, {
    cwd,
    requestTimeoutMs: safeInteger('requestTimeoutMs', config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 600000),
    disposeGraceMs: safeInteger('disposeGraceMs', config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS, 1, 60000),
    maxResults: safeInteger('maxResults', config.maxResults ?? DEFAULT_MAX_RESULTS, 1, 50),
    maxTurns: safeInteger('maxTurns', config.maxTurns ?? DEFAULT_MAX_TURNS, 1, 16),
    maxPayloadBytes: safeInteger('maxPayloadBytes', config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 1048, 1048576),
    ...(executable === undefined ? {} : { executable }),
  })
  const unregister = ctx.web.registerSearchProvider(provider)
  ctx.effect(function* () {
    yield unregister
    yield () => provider.dispose()
  }, 'web-search-claude-code')
}

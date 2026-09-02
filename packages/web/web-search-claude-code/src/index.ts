import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ClaudeCodeSearchProvider,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
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
export const name = 'web-search-claude-code'
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
  /** Optional Claude executable override. */
  executable?: string
}
export const Config: z<Config> = z.object({
  cwd: z.string(),
  requestTimeoutMs: z.number(),
  disposeGraceMs: z.number(),
  maxResults: z.number(),
  maxTurns: z.number(),
  maxPayloadBytes: z.number(),
  executable: z.string(),
})
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new ClaudeCodeSearchProvider(ctx, {
    cwd: config.cwd ?? process.cwd(),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    maxPayloadBytes: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    ...(config.executable === undefined
      ? {}
      : { executable: config.executable }),
  })
  const dispose = ctx.web.registerSearchProvider(provider)
  ctx.effect(function* () {
    yield dispose
  }, 'web-search-claude-code')
}

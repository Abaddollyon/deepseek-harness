/**
 * Codex CLI subscription web-search Cordis plugin.
 *
 * @module @deepseek-ai/dsh-web-search-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodexSearchProvider } from './provider.ts'

export {
  CODEX_AUTH_MESSAGE,
  CODEX_MISSING_MESSAGE,
  CODEX_PROVIDER_ID,
  CodexSearchProvider,
  WEB_ABORTED,
  WEB_INVALID_CONFIG,
  WEB_PROVIDER_ERROR,
  WEB_PROVIDER_PROTOCOL,
  normalizeCodexResult,
} from './provider.ts'
export type { CodexRawResult, CodexSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'web-search-codex'

/** Required host seams. */
export const inject = ['web', 'subprocess']

/** Optional plugin configuration; defaults are applied by {@link apply}. */
export interface Config {
  /** Working directory; defaults to the host process directory. */
  cwd?: string
  /** Inner request timeout in milliseconds; defaults to 60000. */
  requestTimeoutMs?: number
  /** Process-tree termination grace in milliseconds; defaults to 3000. */
  disposeGraceMs?: number
  /** Provider-side result cap; defaults to 8. */
  maxResults?: number
  /** Serialized result/diagnostic cap in bytes; defaults to 262144. */
  maxPayloadBytes?: number
  /** Bare or absolute Codex executable override. */
  executable?: string
}

/** Schemastery projection of {@link Config}. */
export const Config: z<Config> = z.object({
  cwd: z.string(),
  requestTimeoutMs: z.number().step(1).min(1).max(600_000),
  disposeGraceMs: z.number().step(1).min(1).max(60_000),
  maxResults: z.number().step(1).min(1).max(50),
  maxPayloadBytes: z.number().step(1).min(1_048).max(1_048_576),
  executable: z.string(),
})

/** Register the fixed-id Codex provider and bind process cleanup to this Fiber. */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new CodexSearchProvider(ctx.subprocess, {
    cwd: config.cwd ?? process.cwd(),
    requestTimeoutMs: config.requestTimeoutMs ?? 60_000,
    disposeGraceMs: config.disposeGraceMs ?? 3_000,
    maxResults: config.maxResults ?? 8,
    maxPayloadBytes: config.maxPayloadBytes ?? 262_144,
    ...(config.executable === undefined ? {} : { executable: config.executable }),
  })
  const unregister = ctx.web.registerSearchProvider(provider)
  ctx.effect(function* () {
    yield async () => {
      await provider.dispose()
      unregister()
    }
  }, 'web-search-codex')
}

/**
 * Official Codex app-server search provider registered into `ctx.web`.
 * Authentication remains entirely inside the official Codex process.
 * @module @deepseek-ai/dsh-web-search-codex
 */

import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import { nonEmptyConfigString, positiveSafeIntegerConfig } from '@deepseek-ai/dsh-web'
import {
  CodexSearchProvider,
  DEFAULT_CODEX_SEARCH_GRACE_MS,
} from './provider.ts'

export {
  CODEX_SEARCH_PROVIDER_ID,
  CodexSearchProvider,
  DEFAULT_CODEX_SEARCH_GRACE_MS,
} from './provider.ts'
export type { CodexSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'web-search-codex'
/** Required service seams. */
export const inject = ['web', 'subprocess']

/** Codex native web-search deployment config. */
export interface Config {
  /** Working directory passed to the official app-server thread. */
  cwd?: string
  /** Managed process-tree termination grace. */
  graceMs?: number
}

/** Loader schema for Codex native search config. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  graceMs: z.natural().min(1).default(DEFAULT_CODEX_SEARCH_GRACE_MS),
})

/** Register one subscription-native Codex provider. */
export function apply(ctx: Context, config: Config = {}): void {
  const cwd = nonEmptyConfigString('cwd', config.cwd ?? process.cwd())
  ctx.web.registerSearchProvider(new CodexSearchProvider(ctx, {
    cwd,
    graceMs: positiveSafeIntegerConfig('graceMs', config.graceMs ?? DEFAULT_CODEX_SEARCH_GRACE_MS),
  }))
}

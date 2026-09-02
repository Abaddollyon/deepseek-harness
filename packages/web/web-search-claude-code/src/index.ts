/**
 * Official Claude Agent SDK search provider registered into `ctx.web`.
 * OAuth remains entirely inside the SDK and its Claude Code process.
 * @module @deepseek-ai/dsh-web-search-claude-code
 */

import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import { nonEmptyConfigString, positiveSafeIntegerConfig } from '@deepseek-ai/dsh-web'
import {
  ClaudeCodeSearchProvider,
  DEFAULT_CLAUDE_CODE_SEARCH_GRACE_MS,
  DEFAULT_CLAUDE_CODE_SEARCH_MAX_TURNS,
} from './provider.ts'

export {
  CLAUDE_CODE_SEARCH_PROVIDER_ID,
  ClaudeCodeSearchProvider,
  DEFAULT_CLAUDE_CODE_SEARCH_GRACE_MS,
  DEFAULT_CLAUDE_CODE_SEARCH_MAX_TURNS,
} from './provider.ts'
export type { ClaudeCodeSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'web-search-claude-code'
/** Required service seams. */
export const inject = ['web', 'subprocess']

/** Claude Code native web-search deployment config. */
export interface Config {
  /** Working directory passed to the official Agent SDK. */
  cwd?: string
  /** Managed process-tree termination grace. */
  graceMs?: number
  /** Maximum SDK conversation turns for one batch. */
  maxTurns?: number
}

/** Loader schema for Claude Code native search config. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  graceMs: z.natural().min(1).default(DEFAULT_CLAUDE_CODE_SEARCH_GRACE_MS),
  maxTurns: z.natural().min(1).default(DEFAULT_CLAUDE_CODE_SEARCH_MAX_TURNS),
})

/** Register one subscription-native Claude Code provider. */
export function apply(ctx: Context, config: Config = {}): void {
  const cwd = nonEmptyConfigString('cwd', config.cwd ?? process.cwd())
  ctx.web.registerSearchProvider(new ClaudeCodeSearchProvider(ctx, {
    cwd,
    graceMs: positiveSafeIntegerConfig('graceMs', config.graceMs ?? DEFAULT_CLAUDE_CODE_SEARCH_GRACE_MS),
    maxTurns: positiveSafeIntegerConfig('maxTurns', config.maxTurns ?? DEFAULT_CLAUDE_CODE_SEARCH_MAX_TURNS),
  }))
}

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodexSearchProvider } from './provider.ts'
export { CodexSearchProvider, CODEX_PROVIDER_ID, WEB_ABORTED, WEB_PROVIDER_ERROR, WEB_PROVIDER_PROTOCOL, WEB_INVALID_CONFIG, CODEX_AUTH_MESSAGE, CODEX_MISSING_MESSAGE } from './provider.ts'
export type { CodexSearchProviderOptions } from './provider.ts'
export const name = 'web-search-codex'
export const inject = ['web', 'subprocess']
export interface Config { cwd?: string; requestTimeoutMs?: number; disposeGraceMs?: number; maxResults?: number; maxPayloadBytes?: number; executable?: string }
export const Config: z<Config> = z.object({ cwd:z.string(),requestTimeoutMs:z.number().step(1).min(1).max(600000),disposeGraceMs:z.number().step(1).min(1).max(60000),maxResults:z.number().step(1).min(1).max(50),maxPayloadBytes:z.number().step(1).min(1048).max(1048576),executable:z.string() })
export function apply(ctx: Context, config: Config = {}): void {
  const provider=new CodexSearchProvider(ctx.subprocess,{ cwd:config.cwd ?? process.cwd(),requestTimeoutMs:config.requestTimeoutMs ?? 60000,disposeGraceMs:config.disposeGraceMs ?? 3000,maxResults:config.maxResults ?? 8,maxPayloadBytes:config.maxPayloadBytes ?? 262144,...config.executable !== undefined ? { executable:config.executable } : {} })
  const dispose=ctx.web.registerSearchProvider(provider)
  ctx.effect(function*(){ yield dispose }, 'web-search-codex')
}

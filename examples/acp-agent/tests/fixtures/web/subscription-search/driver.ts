#!/usr/bin/env node
import { boot, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-web'

const [configPath, patchPath, ...extra] = process.argv.slice(2)
if (configPath === undefined || patchPath === undefined || extra.length !== 0) {
  throw new Error('subscription-search fixture requires config plus one provider Bundle patch')
}
const ctx = await boot(
  'subscription-search-loader-composition',
  resolveConfigPath(configPath, undefined),
  loadOverlayPatches('subscription-search-loader-composition', patchPath),
)
try {
  const providers = (ctx.web as unknown as { searchProviders: Map<string, unknown> }).searchProviders
  const outcomes = process.env.DSH_FIXTURE_LOAD_ONLY === '1'
    ? []
    : await ctx.web.searchMany({ queries: ['loader query'] })
  process.stdout.write(JSON.stringify({ providers: [...providers.keys()].sort(), outcomes }) + '\n')
} finally {
  await ctx.fiber.dispose()
}

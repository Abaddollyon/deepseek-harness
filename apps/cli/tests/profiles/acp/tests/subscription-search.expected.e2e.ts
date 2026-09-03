import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { runSubscriptionFixture } from './subscription-search.fixture.ts'

const ROOT = fileURLToPath(new URL('../../../../../../examples/acp-agent/tests/fixtures/web/subscription-search/', import.meta.url))
const CODEX_SERVER = fileURLToPath(new URL('../../../../../../packages/web/web-search-codex/tests/fixtures/app-server.mjs', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

for (const provider of ['codex', 'claude-code'] as const) {
  describe(`ACP subscription-search fixture: ${provider}`, () => {
    it('matches its deterministic keyless snapshot', async () => {
      const ctx = new Context()
      try {
        const actual = await runSubscriptionFixture(ctx, provider, CODEX_SERVER)
        const expectedPath = join(ROOT, provider, 'snapshot.expected.json')
        const serialized = JSON.stringify(actual, null, 2) + '\n'
        if (refreshing) await writeFile(expectedPath, serialized)
        expect(actual).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })
}

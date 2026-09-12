/** Real cache/storage composition for detached observation lifecycle tests. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '../src/index.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'observation-test/count': number }
  interface SessionProjectionMap { 'observation-test/count': number }
}

/**
 * Mount the real JSON-backed checkpoint writer with an optional event counter.
 * @param ctx - Test-owned context disposed by the caller.
 * @param root - Caller-owned private storage directory.
 * @param register - Whether the observation has a projection unit to restore.
 */
export async function mountObservationCache(ctx: Context, root: string, register: boolean): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionProjectionRegistry)
  if (register) {
    ctx.sessionProjections.register({
      key: 'observation-test/count', stateVersion: 1, stateSchema: z.number(),
      init: () => 0,
      apply: state => state + 1,
      wire: { viewSchema: z.number(), view: state => state },
    })
  }
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
}

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-environment-runtime/client'

interface HostCarrier {
  generations: Array<{ ready(): void; drop(): void; signal: AbortSignal }>
}

export function createHostPlugin(
  hosts: ReadonlyMap<string, HostCarrier>,
  contexts: Map<string, Context>,
  fallback: () => never,
) {
  return {
    inject: ['connection', 'environmentRuntime'],
    apply(ctx: Context) {
      ctx.provide('remote', { fileUploads: { upload: fallback } })
      const id = ctx.environmentRuntime.environmentId
      const host = hosts.get(id)
      if (host === undefined) return
      contexts.set(id, ctx)
      const connection = ctx.get('connection') as ConnectionHandle
      ctx.effect(() => connection.registerGenerationSource((signal, ready) => new Promise<void>((resolve) => {
        host.generations.push({ signal, ready: () => { ready({ home: `/${id}` }) }, drop: resolve })
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })))
      const loop = connection.start({}, { backoffBaseMs: 1, backoffMaxMs: 1, backoffFactor: 1 })
      ctx.effect(() => () => { loop.stop() })
    },
  }
}

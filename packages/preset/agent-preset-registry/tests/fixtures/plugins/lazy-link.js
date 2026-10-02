// Publishes `link` at once and connects on its first request, like a remote host's SSH link; `connects` counts connections.
export const name = 'lazy-link'
export function apply(ctx) {
  let connected
  const link = {
    connects: 0,
    request: async () => { await (connected ??= Promise.resolve().then(() => { link.connects++ })) },
  }
  ctx.effect(() => ctx.reflect.provide('link', link))
}

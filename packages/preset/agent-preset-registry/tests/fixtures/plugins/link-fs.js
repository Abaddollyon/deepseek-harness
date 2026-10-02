// Publishes an `fs` whose every operation goes through the `link` service; `/srv/app` is its only directory.
export const name = 'link-fs'
export const inject = ['link']
export function apply(ctx) {
  ctx.effect(() => ctx.reflect.provide('fs', {
    resolve: async (path) => { await ctx.link.request(); return path },
    stat: async (path) => { await ctx.link.request(); return path === '/srv/app' ? { type: 'directory' } : undefined },
  }))
}

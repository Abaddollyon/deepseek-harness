// Publishes a minimal `fs` whose only directories are `config.directories`.
export const name = 'world-fs'
export function apply(ctx, config) {
  ctx.effect(() => ctx.reflect.provide('fs', {
    resolve: async path => path,
    stat: async path => config.directories.includes(path) ? { type: 'directory' } : undefined,
  }))
}

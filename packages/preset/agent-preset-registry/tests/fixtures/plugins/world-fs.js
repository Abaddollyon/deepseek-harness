// Publishes a minimal `fs` whose only directories are `config.directories`; `config.failing` paths reject.
export const name = 'world-fs'
export function apply(ctx, config) {
  ctx.effect(() => ctx.reflect.provide('fs', {
    resolve: async path => path,
    stat: async (path) => {
      if (config.failing?.includes(path)) throw new Error('host unreachable')
      return config.directories.includes(path) ? { type: 'directory' } : undefined
    },
  }))
}

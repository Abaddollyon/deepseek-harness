import { defineConfig } from 'tsdown'

/** Build both public plugin roles together so their shared service retains one identity. */
export default defineConfig(({ env }) => {
  // The Client pass must neither clean nor rewrite the completed Host artifacts.

  if (env?.DSH_BUILD_FACE === 'client') return { entry: '' }
  return {
    entry: { index: 'lib/types/index.js', host: 'lib/types/host.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // Clean runtime outputs, including stale shared chunks; preserve lib/types inputs/declarations.
    clean: ['lib/*.js'],
  }
})

import { defineConfig } from 'tsdown'

/** Node-only service seam. */
export default defineConfig([{
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}])

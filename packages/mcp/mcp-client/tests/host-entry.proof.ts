import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** Verify built public entries. Run only after the normal Host build, never as a source-only unit test. */
export async function verifyMcpHostEntry(): Promise<void> {
  // Native Node imports the built public exports, outside Vitest's source aliases.
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  try {
    await Promise.all(['lib/index.js', 'lib/host.js', 'lib/types/host.d.ts'].map(path => access(join(packageRoot, path))))
  } catch {
    throw new Error('MCP Host entry artifacts are missing; run pnpm run build:lib:host before this artifact gate')
  }
  const directory = await mkdtemp(join(packageRoot, '.host-loader-'))
  try {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./host-loader.fixture.ts', import.meta.url)), directory], {
      cwd: packageRoot,
      timeout: 4_000,
      encoding: 'utf8',
    })
    assert.ok(result.stdout.includes('HOST_LOADER_OK'), 'the Loader fixture did not finish')
  } finally {
    // The parent owns cleanup even when the child fails or reaches its process deadline.
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Canonicalize a fully qualified directory path via `fs.realpath`: trailing
 * slashes, `..` segments, and symlinks are all resolved. This is the ONE
 * uniqueness canon of the package — workspace paths are stored canonicalized,
 * uniqueness is string equality of canonicalized paths (a symlink to an
 * existing workspace's directory collides), and attach-time session `cwd`
 * checks go through the same canon. Relative paths reject before `realpath` can
 * resolve them from the Host cwd or current Windows drive. A path that does not
 * exist rejects with the original `ENOENT` — this is `create`'s reject path (a
 * workspace must point at an existing directory).
 * @param path - The path to canonicalize.
 * @returns the canonical absolute path.
 */
export async function realpathNormalize(path: string): Promise<string> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  return await realpath(path)
}

/**
 * Canonicalize and validate additional Workspace roots, preserving first-seen
 * order and excluding the primary root. Every path must resolve to a directory.
 * @param paths - Candidate additional roots.
 * @param primary - Canonical primary Workspace root.
 * @returns canonical, deduplicated additional roots.
 */
export async function normalizeAdditionalWorkspacePaths(
  paths: readonly string[],
  primary: string,
): Promise<string[]> {
  const normalized: string[] = []
  const seen = new Set<string>([primary])
  for (const path of paths) {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`Workspace additional path '${path}' is not a directory`)
    }
    if (!seen.has(canonical)) {
      seen.add(canonical)
      normalized.push(canonical)
    }
  }
  return normalized
}

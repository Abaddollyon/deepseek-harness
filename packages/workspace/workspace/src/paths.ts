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

/** Directory identity operations of one execution world that holds Workspace paths. */
export interface WorkspacePathWorld {
  /**
   * Canonicalize a fully qualified path where its files exist.
   * @param path - Candidate path in that world's spelling.
   * @returns the canonical path; rejects when the path does not resolve.
   */
  realpath(path: string): Promise<string>
  /**
   * Report whether a canonical path names an existing directory.
   * @param path - Canonical path.
   * @returns whether it is a directory; rejects when it cannot be inspected.
   */
  isDirectory(path: string): Promise<boolean>
}

/** The Host filesystem: the world of every Workspace without an Agent preset. */
export const hostPathWorld: WorkspacePathWorld = {
  realpath: realpathNormalize,
  isDirectory: async path => (await stat(path)).isDirectory(),
}

/**
 * Identity of one directory across execution worlds: Host paths stay plain,
 * while a path in an Agent preset's world is qualified by that preset.
 * @param agentPreset - Preset owning the world, or undefined for the Host.
 * @param path - Canonical path in that world.
 * @returns the world-qualified key.
 */
export function workspacePathKey(agentPreset: string | undefined, path: string): string {
  return agentPreset === undefined ? path : `${agentPreset}\u0000${path}`
}

/**
 * Canonicalize additional Workspace directories in one execution world,
 * keeping first-seen order and dropping duplicates and the primary path.
 * @param paths - Candidate additional directories.
 * @param primary - Canonical primary Workspace path.
 * @param world - Execution world holding the directories; the Host by default.
 * @returns the canonical additional directories; rejects when any path is not an existing directory.
 */
export async function normalizeAdditionalWorkspacePaths(
  paths: readonly string[],
  primary: string,
  world: WorkspacePathWorld = hostPathWorld,
): Promise<string[]> {
  const seen = new Set([primary])
  const normalized: string[] = []
  for (const path of paths) {
    const canonical = await world.realpath(path)
    if (!(await world.isDirectory(canonical))) {
      throw new Error(`Workspace additional path '${path}' is not a directory`)
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    normalized.push(canonical)
  }
  return normalized
}

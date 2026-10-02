/** Workspace path identity in Agent presets that mount their own filesystem. */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { WorkspacePathWorld } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceWorld } from './types.ts'

/**
 * Adapt a preset's filesystem to Workspace path identity. Preset worlds are
 * POSIX execution hosts (the SSH provider family), so paths must be absolute
 * POSIX spellings; canonicalization happens where the files exist.
 * @param fs - The preset's own filesystem provider.
 * @returns the world Workspace records in that preset use.
 */
export function filesystemPathWorld(fs: FileSystem): WorkspacePathWorld {
  const target = async (path: string) => {
    if (!posix.isAbsolute(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
    return await fs.resolve(path)
  }
  return {
    realpath: async (path) => {
      const resolved = await target(path)
      if (await fs.stat(resolved) === undefined) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`)
      return fs.processPath(resolved)
    },
    isDirectory: async path => (await fs.stat(await target(path)))?.type === 'directory',
  }
}

/**
 * The world of a preset that owns one while its filesystem provider is
 * missing: every path operation rejects, so nothing is read from the Host.
 * @param agentPreset - The preset whose world is unavailable.
 * @returns a world whose operations reject.
 */
function unavailablePathWorld(agentPreset: string): WorkspacePathWorld {
  const unavailable = () => Promise.reject(new Error(`the execution world of agent preset '${agentPreset}' is not available`))
  return { realpath: unavailable, isDirectory: unavailable }
}

/**
 * Bind the Workspace registry to the filesystems Agent presets isolate, for
 * as long as the preset registry is composed. A preset that owns its world
 * keeps it while that world is unavailable instead of resolving to the Host.
 * @param ctx - Host context carrying the Workspace registry.
 */
export function installPresetPathWorlds(ctx: Context): void {
  ctx.inject(['agentPresets'], (scope) => {
    scope.effect(() => ctx.workspaceRegistry.setPathWorlds((agentPreset) => {
      const fs = scope.agentPresets.serviceForPreset(agentPreset, 'fs')
      if (fs !== undefined) return filesystemPathWorld(fs)
      return scope.agentPresets.ownsWorld(agentPreset) ? unavailablePathWorld(agentPreset) : undefined
    }), 'workspace-controller.presetPathWorlds')
  })
}

/**
 * List the Agent presets whose execution world can hold Workspaces.
 * @param ctx - Host context; an absent preset registry lists none.
 * @returns usable presets that mount their own filesystem, in roster order.
 */
export async function listPresetWorlds(ctx: Context): Promise<WorkspaceWorld[]> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return []
  return (await presets.list())
    .filter(preset => preset.broken === undefined && presets.serviceForPreset(preset.id, 'fs') !== undefined)
    .map(preset => ({ agentPreset: preset.id, ...preset.name === undefined ? {} : { name: preset.name } }))
}

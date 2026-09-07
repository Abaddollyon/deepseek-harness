/** Workspace-specific adapter for the Gateway-owned snapshot stream lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ClientWorkspaceModel } from './model.ts'
import { WorkspaceFeedRecovery } from './feed.ts'
import { WorkspaceController } from './service.ts'

export { ClientWorkspaceModel } from './model.ts'
export type {
  WorkspaceFollowSink, WorkspaceListPhase, WorkspaceRemote, WorkspaceSnapshot,
} from './model.ts'
export { WorkspaceController, WorkspaceCreateError } from './service.ts'
export type { IWorkspaces, WorkspaceSource } from './service.ts'
export type { WorkspaceId, WorkspaceView } from '../types.ts'

export { createWorkspaceStateStream } from './transport.ts'
export type { WorkspaceStateStream, WorkspaceStateStreamOptions } from './transport.ts'
export type { WorkspaceFeedSnapshot } from './feed.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free Client Workspace state and commands. */
    workspaces: import('./service.ts').IWorkspaces
  }
}

/** Required Client Remote services. */
export const inject = ['remote', 'remote.workspace']

/** Client readiness retry schedule; empty disables automatic retries. */
export const Config: z<Config> = z.object({
  followRetryDelaysMs: z.array(z.natural().max(60_000)).max(20).default([250, 500, 1000, 2000, 4000]),
})

/** Resolved Workspace readiness timing. */
export interface Config {
  /** Finite delays between temporary service-absence attempts. */
  followRetryDelaysMs: number[]
}

/**
 * Install Workspace state and its resource-specific readiness owner.
 * @param ctx - Client root context.
 * @param config - Validated readiness retry schedule.
 */
export function apply(ctx: Context, config: Config): void {
  const model = new ClientWorkspaceModel(ctx.remote.workspace)
  const recovery = new WorkspaceFeedRecovery(ctx.remote, model, config.followRetryDelaysMs)
  new WorkspaceController(ctx, model, recovery)
  recovery.retry()
  ctx.effect(() => () => recovery.dispose(), 'workspace-controller.client.control')
}

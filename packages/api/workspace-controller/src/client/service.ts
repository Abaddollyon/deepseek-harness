/** React-free Client Workspace service and command facade. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceView } from '../types.ts'
import type { WorkspaceFeedRecovery, WorkspaceFeedSnapshot } from './feed.ts'
import type { ClientWorkspaceModel, WorkspaceSnapshot } from './model.ts'

/** Structured create failure for callers that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  override readonly name = 'WorkspaceCreateError'

  /** @param rpcError - Host business or folded carrier failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Bare observable source for the Workspace Controller snapshot. */
export interface WorkspaceSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): WorkspaceSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Workspace Controller's Client service face. */
export interface IWorkspaces {
  /** Host-authoritative Workspace rows, order, archive set, and follow lifecycle. */
  readonly list: WorkspaceSource
  /** Sanitized follow readiness diagnostics, independent of retained rows. */
  readonly feed: { getSnapshot(): WorkspaceFeedSnapshot; subscribe(listener: () => void): () => void }
  /** Retry only a failed Workspace read subscription; never replay commands. */
  retryFeed(): void
  /**
   * Register an existing path as a Workspace.
   * @param input - Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * Rename a Workspace.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns the renamed Workspace.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace registration without deleting Sessions or files.
   * @param workspaceId - target Workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the Host registry order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Archive a Session from Workspace grouping surfaces.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Move a Session within one Workspace account.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to move.
   * @param beforeSessionId - anchor Session; omitted appends.
   * @returns the changed Workspace.
   */
  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>
}

/** Owns the bare Workspace snapshot and Workspace-only commands. */
export class WorkspaceController extends Service implements IWorkspaces {
  readonly list: WorkspaceSource
  readonly feed: WorkspaceFeedRecovery['snapshot']

  /**
   * @param ctx - Client root Context.
   * @param model - Remote-backed Workspace state model.
   * @param recovery - Resource-owned follow lifecycle.
   */
  constructor(ctx: Context, private readonly model: ClientWorkspaceModel, private readonly recovery: WorkspaceFeedRecovery) {
    super(ctx, 'workspaces')
    this.list = model
    this.feed = recovery.snapshot
  }

  retryFeed(): void { this.recovery.retry() }

  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.model.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.model.rename(workspaceId, title)
    if (!result.ok) throw commandError('rename', result.error)
    return result.value.workspace
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.model.delete(workspaceId)
    if (!result.ok) throw commandError('delete', result.error)
  }

  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.model.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw commandError('reorder', result.error)
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.archiveSession(sessionId)
    if (!result.ok) throw commandError('session archive', result.error)
  }

  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.model.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw commandError('move', result.error)
    return result.value.workspace
  }
}

function commandError(operation: string, failure: RemoteFailure): Error {
  return new Error(`workspace ${operation} failed: ${failure.code}: ${failure.message}`)
}

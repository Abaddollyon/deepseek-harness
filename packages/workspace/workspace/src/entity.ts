/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId } from './types.ts'
import { normalizeAdditionalWorkspacePaths, workspacePathKey, type WorkspacePathWorld } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, the canonical session-path
 * index backing the `sessionIds` projection, and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Read a session's world-qualified canonical directory from the registry's header index.
   * @param id - Session whose indexed path is requested.
   * @returns the {@link workspacePathKey} of its directory, or `undefined` when
   * the header is missing or its cwd cannot identify an existing directory.
   */
  sessionPath(id: SessionId): string | undefined

  /**
   * Resolve the execution world holding a Workspace's paths.
   * @param agentPreset - Preset named by the record, or undefined for the Host.
   * @returns that world; rejects synchronously when the preset's world is unavailable.
   */
  world(agentPreset: string | undefined): WorkspacePathWorld

  /**
   * Name the execution world a Session header runs in.
   * @param header - Stored or live header.
   * @returns the header's preset when it owns a Workspace world, otherwise undefined for the Host.
   */
  sessionWorld(header: SessionHeader): string | undefined

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - World-qualified key of the canonical directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, session-path index, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get agentPreset(): string | undefined {
    return this.record.agentPreset
  }

  get additionalPaths(): readonly string[] {
    return this.record.additionalPaths ?? []
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    const key = workspacePathKey(this.record.agentPreset, this.record.path)
    return this.record.sessionIds.filter(id => this.host.sessionPath(id) === key)
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async setAdditionalPaths(additionalPaths: readonly string[]): Promise<void> {
    const world = this.host.world(this.record.agentPreset)
    const normalized = await normalizeAdditionalWorkspacePaths(additionalPaths, this.record.path, world)
    await this.mutate((record) => {
      const current = record.additionalPaths ?? []
      return current.length === normalized.length && current.every((path, index) => path === normalized[index])
        ? record
        : { ...record, additionalPaths: normalized }
    })
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: the cwd fact was checked when it first attached and both inputs
    // (stored header cwd, workspace path) are immutable. Membership itself is
    // decided on the write chain inside `mutate`, never on this snapshot.
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      const sessionWorld = this.host.sessionWorld(header)
      if (sessionWorld !== this.record.agentPreset) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `it runs in ${sessionWorld === undefined ? 'the Host' : `agent preset '${sessionWorld}'`}, `
          + `not ${this.record.agentPreset === undefined ? 'the Host' : `agent preset '${this.record.agentPreset}'`}`,
        )
      }
      const world = this.host.world(this.record.agentPreset)
      let cwd: string
      try {
        cwd = await world.realpath(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await world.isDirectory(cwd))) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, workspacePathKey(this.record.agentPreset, cwd))
    }
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? record
      : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
      : record)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return await this.host.world(this.record.agentPreset).isDirectory(this.record.path) ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss, an
      // unreachable remote world) means the directory is not usable right
      // now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer pass the id-plus-canonical-cwd membership check, then swap the
   * snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const key = workspacePathKey(changed.agentPreset, changed.path)
        const sessionIds = changed.sessionIds.filter(id => this.host.sessionPath(id) === key)
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}

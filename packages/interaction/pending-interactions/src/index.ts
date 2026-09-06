/**
 * Passive lifecycle registry for pending human interactions. Producers report
 * begin/end edges; observers receive content-free snapshots and deltas without
 * any answer capability.
 * @module @deepseek-ai/dsh-pending-interactions
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-wide passive view of pending human interactions. */
    pendingInteractions: PendingInteractionRegistry
  }
}

/** Opaque identity scoped to one pending-interactions Host epoch. */
export type PendingInteractionId = string & { readonly __pendingInteractionId: unique symbol }

/** Public interaction categories; plan review remains a presentation-specific question. */
export type PendingInteractionKind = 'approval' | 'question' | 'plan-review'

/** Content-free record exposed while one interaction is pending. */
export interface PendingInteractionRecord {
  readonly id: PendingInteractionId
  readonly kind: PendingInteractionKind
  readonly agentId?: string
  readonly sessionId?: string
  readonly startedAtMs: number
}

/** Reconnect baseline for one registry activation. */
export interface PendingInteractionSnapshot {
  readonly epoch: string
  readonly revision: number
  readonly pending: readonly PendingInteractionRecord[]
}

/** Revisioned lifecycle edge following a snapshot from the same epoch. */
export type PendingInteractionChange =
  | {
    readonly epoch: string
    readonly revision: number
    readonly type: 'began'
    readonly interaction: PendingInteractionRecord
  }
  | {
    readonly epoch: string
    readonly revision: number
    readonly type: 'ended'
    readonly interaction: PendingInteractionRecord
    readonly endedAtMs: number
  }

/** Read-only face suitable for status projections and remote observers. */
export interface PendingInteractionObserver {
  snapshot(): PendingInteractionSnapshot
  onChange(listener: (change: PendingInteractionChange) => void | Promise<void>): () => void
}

/** Producer input. The registry derives identity and never borrows request contents. */
export interface PendingInteractionBegin {
  readonly kind: PendingInteractionKind
  readonly agent?: Agent
}

/** Host registry of current pending interactions and their revisioned lifecycle. */
export class PendingInteractionRegistry extends Service implements PendingInteractionObserver {
  private readonly epoch = randomUUID()
  private readonly pending = new Map<PendingInteractionId, PendingInteractionRecord>()
  private readonly listeners = new Set<(change: PendingInteractionChange) => void | Promise<void>>()
  private revision = 0
  private active = true

  constructor(ctx: Context) {
    super(ctx, 'pendingInteractions')
    ctx.on('agent/disposed', ({ agent }) => {
      for (const record of [...this.pending.values()]) {
        if (record.agentId === agent.id) this.end(record.id)
      }
    })
    ctx.effect(() => () => {
      this.active = false
      for (const id of [...this.pending.keys()]) this.end(id)
      this.listeners.clear()
    }, 'pending-interactions: Host lifetime')
  }

  /**
   * Begin one content-free lifecycle.
   * @param input - interaction kind and optional owning agent.
   * @returns the idempotent end capability.
   */
  begin(input: PendingInteractionBegin): () => void {
    if (!this.active) return () => {}
    const id = randomUUID() as PendingInteractionId
    const agent = input.agent
    const record = Object.freeze({
      id,
      kind: input.kind,
      ...(agent === undefined ? {} : {
        agentId: String(agent.id),
        sessionId: String(agent.session.id),
      }),
      startedAtMs: Date.now(),
    })
    this.pending.set(id, record)
    this.revision += 1
    this.notify(Object.freeze({
      epoch: this.epoch,
      revision: this.revision,
      type: 'began',
      interaction: record,
    }))
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.end(id)
    }
  }

  /**
   * Read the current immutable baseline; historical ended interactions are absent.
   * @returns epoch, revision, and current pending records.
   */
  snapshot(): PendingInteractionSnapshot {
    return Object.freeze({
      epoch: this.epoch,
      revision: this.revision,
      pending: Object.freeze([...this.pending.values()]),
    })
  }

  /**
   * Subscribe to future deltas; callers obtain history through snapshot().
   * @param listener - failure-contained consumer of future lifecycle changes.
   * @returns synchronous unsubscribe capability.
   */
  onChange(listener: (change: PendingInteractionChange) => void | Promise<void>): () => void {
    if (!this.active) return () => {}
    this.listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
    }
  }

  private end(id: PendingInteractionId): void {
    const interaction = this.pending.get(id)
    if (interaction === undefined) return
    this.pending.delete(id)
    this.revision += 1
    this.notify(Object.freeze({
      epoch: this.epoch,
      revision: this.revision,
      type: 'ended',
      interaction,
      endedAtMs: Date.now(),
    }))
  }

  private notify(change: PendingInteractionChange): void {
    const recipients = [...this.listeners]
    queueMicrotask(() => {
      for (const listener of recipients) {
        if (!this.listeners.has(listener)) continue
        try {
          const returned = listener(change)
          void Promise.resolve(returned).catch((error: unknown) => {
            this.ctx.logger.error(error)
          })
        } catch (error: unknown) {
          this.ctx.logger.error(error)
        }
      }
    })
  }
}

export default PendingInteractionRegistry

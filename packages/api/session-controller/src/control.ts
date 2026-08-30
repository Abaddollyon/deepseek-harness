/** Live Session queue, jobs, and projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {
  JsonValue, Session, SessionEvent, SessionEventMap, SessionId, UserMessage,
} from '@deepseek-ai/dsh-session'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionJob,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionQueuedItem,
} from './types.ts'

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()

  /** @param ctx - Host context carrying live Agent, projection, and jobs services. */
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
        this.broadcast({
          type: 'projection',
          sessionId: session.id,
          key,
          value: value as JsonValue,
          seq,
        })
      })
    })
    ctx.inject(['jobs'], (jobsCtx) => {
      jobsCtx.jobs.onJobsChanged((owner) => { this.onJobsChanged(owner) })
    })
    ctx.on('session/created', (session) => {
      const jobs = this.jobsFor(this.ctx.agents.get(session.id))
      if (jobs.length > 0) this.broadcast({ type: 'jobs', sessionId: session.id, jobs })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    const queues = Object.create(null) as Record<SessionId, readonly SessionQueuedItem[]>
    const jobs = Object.create(null) as Record<SessionId, readonly SessionJob[]>
    for (const session of sessions) {
      const agent = this.ctx.agents.get(session.id)
      queues[session.id] = agent?.session === session ? queueItems(agent) : []
      jobs[session.id] = this.jobsFor(agent)
    }
    return {
      queues,
      jobs,
      projections: this.projectionBaseline(sessions),
    }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const registry = this.ctx.get('sessionProjections')
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    for (const session of sessions) {
      const snapshot = registry?.snapshot(session)
      blocks[session.id] = snapshot === undefined
        ? { asOfSeq: session.seq - 1, values: {} }
        : {
          asOfSeq: snapshot.asOfSeq,
          // Every projection definition validates its value before snapshot publication.
          values: snapshot.values as SessionProjectionValues,
        }
    }
    return blocks
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'agent/inbox/spliced') return
    const agent = this.ctx.agents.get(session.id)
    if (agent?.session !== session) return
    this.broadcast({
      type: 'queue',
      sessionId: session.id,
      items: queueItems(agent, event.data),
    })
  }

  private onJobsChanged(owner: Agent | undefined): void {
    if (owner !== undefined) {
      this.broadcast({ type: 'jobs', sessionId: owner.id, jobs: this.jobsFor(owner) })
      return
    }
    for (const session of this.ctx.sessions.list()) {
      this.broadcast({
        type: 'jobs',
        sessionId: session.id,
        jobs: this.jobsFor(this.ctx.agents.get(session.id)),
      })
    }
  }

  private jobsFor(agent: Agent | undefined): SessionJob[] {
    const jobs = this.ctx.get('jobs')
    return jobs === undefined ? [] : jobs.list(agent).map(jobView)
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

/**
 * The (Session, projection key) identity a newer queued frame supersedes.
 * Kept as a tuple and stored in nested maps, so any byte — NUL included — is
 * safe inside either half and two distinct pairs can never collide.
 */
interface SupersedingKey {
  readonly sessionId: SessionId
  readonly key: string
}

/** One linked queue node; keyed nodes may be unlinked when a newer frame supersedes them. */
class QueueNode {
  /** Previous node toward the head, undefined at the head. */
  prev: QueueNode | undefined
  /** Next node toward the tail, undefined at the tail. */
  next: QueueNode | undefined

  /**
   * @param frame - the frame to deliver unless it is superseded first.
   * @param key - the superseding identity this node occupies, or undefined when the frame must always be delivered.
   */
  constructor(
    readonly frame: SessionControlFrame,
    readonly key: SupersedingKey | undefined,
  ) {}
}

/**
 * Per-stream async queue: the controller's broadcasts push, the control
 * generation's AsyncIterable pulls; abort/return cleans up.
 *
 * A push may carry a superseding identity. While an undelivered node with that
 * identity is still queued, a newer frame unlinks it in O(1) — the superseded
 * frame is never delivered and its memory is released immediately, so a
 * stalled consumer's queue stays bounded by one node per identity plus the
 * unkeyed frames, and the drain never scans tombstones. Unlinking touches only
 * the superseded node, so every other frame keeps its pushed relative order.
 * This is only sound for a frame whose payload is the COMPLETE current state
 * of its identity, so that the newer frame alone reconstructs everything the
 * dropped one carried; {@link controlSupersedingKey} owns that judgement per
 * frame kind.
 */
export class ControlQueue {
  private head: QueueNode | undefined
  private tail: QueueNode | undefined
  /** Undelivered keyed nodes per (Session, projection key), so a newer frame can find the one it supersedes. */
  private readonly supersedable = new Map<SessionId, Map<string, QueueNode>>()
  private wake: (() => void) | undefined
  private done = false
  private length = 0

  /** Frames still queued for delivery; superseded nodes are already unlinked. */
  get size(): number {
    return this.length
  }

  /**
   * Queue one frame, superseding any undelivered frame with the same identity.
   * @param frame - the frame to deliver; ignored after {@link end}.
   */
  push(frame: SessionControlFrame): void {
    if (this.done) return
    const key = controlSupersedingKey(frame)
    if (key === undefined) {
      this.append(new QueueNode(frame, undefined))
    } else {
      const prior = this.supersedable.get(key.sessionId)?.get(key.key)
      if (prior !== undefined) this.unlink(prior)
      const node = new QueueNode(frame, key)
      let byKey = this.supersedable.get(key.sessionId)
      if (byKey === undefined) {
        byKey = new Map()
        this.supersedable.set(key.sessionId, byKey)
      }
      byKey.set(key.key, node)
      this.append(node)
    }
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /** Stop accepting frames; frames already queued still flush to an active drain. */
  end(): void {
    if (this.done) return
    this.done = true
    this.supersedable.clear()
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * Pull queued frames until the queue ends; buffered frames flush on end but are dropped on abort.
   * @param signal - remote stream cancellation.
   * @returns the delivered frames in queue order.
   */
  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.take()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (!signal.aborted) {
        const frame = this.take()
        if (frame === undefined) return
        yield frame
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }

  /** Link one node at the tail. */
  private append(node: QueueNode): void {
    node.prev = this.tail
    if (this.tail === undefined) this.head = node
    else this.tail.next = node
    this.tail = node
    this.length += 1
  }

  /** Detach one node, leaving every other node's delivery order untouched. */
  private unlink(node: QueueNode): void {
    if (node.prev === undefined) this.head = node.next
    else node.prev.next = node.next
    if (node.next === undefined) this.tail = node.prev
    else node.next.prev = node.prev
    this.length -= 1
  }

  /** Detach the head node's frame for delivery, releasing its superseding registration. */
  private take(): SessionControlFrame | undefined {
    const node = this.head
    if (node === undefined) return undefined
    this.head = node.next
    if (node.next === undefined) this.tail = undefined
    else node.next.prev = undefined
    this.length -= 1
    const key = node.key
    if (key !== undefined) {
      const byKey = this.supersedable.get(key.sessionId)
      // After end() the registrations are already released; before it, a
      // linked keyed node is always its identity's current registration.
      if (byKey !== undefined) {
        byKey.delete(key.key)
        if (byKey.size === 0) this.supersedable.delete(key.sessionId)
      }
    }
    return node.frame
  }
}

/**
 * The superseding identity of one control frame, or undefined when the frame
 * must be delivered no matter what follows it.
 *
 * Sole owner of the coalescing safety judgement, and deliberately narrow.
 *
 * `projection` qualifies on both counts a drop requires. It carries a unit's
 * COMPLETE finished value plus the watermark `seq` it was computed at, and
 * the client store applies it as `seq <= current ? ignore : replace`
 * (ProjectionValueStore.apply, src/client/sessions/projection-store.ts) — so a
 * frame that a newer one for the same `(session, key)` overtook inside this
 * queue is precisely a frame the client would itself have discarded on
 * arrival. It is also the only kind with the volume to matter: per-event units
 * such as token-meter's out-produce every other control traffic.
 *
 * `queue` and `jobs` are whole-snapshot last-wins frames that would be sound
 * to coalesce, and are still excluded: both fire on rare user or registry
 * actions rather than per event, so there were no frames to save, while
 * collapsing a job's `running -> stopping -> killed` push run would cost a
 * visible transition for nothing. `baseline` never passes through the queue:
 * each control generation yields it directly before any queued frame.
 * @param frame - the queued control frame.
 * @returns the superseding identity, or undefined to always deliver.
 */
function controlSupersedingKey(frame: SessionControlFrame): SupersedingKey | undefined {
  return frame.type === 'projection' ? { sessionId: frame.sessionId, key: frame.key } : undefined
}

function queueItems(
  agent: Agent,
  splice?: SessionEventMap['agent/inbox/spliced'],
): SessionQueuedItem[] {
  const project = (target: 'next-turn' | 'next-step'): readonly UserMessage[] => {
    const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
    return splice?.target === target
      ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      : messages
  }
  return [
    ...project('next-turn').map(message => ({
      id: message.id,
      placement: 'queued' as const,
      ...promptRpcId(message),
      message: { id: message.id, content: message.content as unknown as JsonValue[] },
    })),
    ...project('next-step').map(message => ({
      id: message.id,
      placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
      ...promptRpcId(message),
      message: { id: message.id, content: message.content as unknown as JsonValue[] },
    })),
  ]
}

/** Prompt-RPC identity carried by a browser-submitted message's user source. */
function promptRpcId(message: UserMessage): Pick<SessionQueuedItem, 'rpcId'> {
  const source = message.source
  return source.kind === 'user' && 'rpcId' in source ? { rpcId: source.rpcId } : {}
}

function jobView(job: JobSnapshot): SessionJob {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  }
}

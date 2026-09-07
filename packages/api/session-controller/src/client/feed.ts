/** Bounded recovery of the Session control baseline and authoritative list. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, remoteErrorOf, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionControlStream, type SessionControlStream } from './transport.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import type { SessionControlFrame } from '../types.ts'

/** Session data readiness, independent of transport connectivity and retained rows. */
export interface SessionFeedSnapshot {
  /** Stale retains an accepted baseline while recovery is pending or exhausted. */
  readonly state: 'loading' | 'retrying' | 'ready' | 'error' | 'stale'
  readonly error: RemoteFailure | null
  /** Zero-based automatic retry number, reset by an explicit retry. */
  readonly attempt: number
}

/** Lifecycle owner for control readiness; only typed temporary service absence retries. */
export class SessionFeedRecovery {
  /** Observable status retained independently of Session rows. */
  readonly snapshot = createSnapshotStore<SessionFeedSnapshot>({ state: 'loading', error: null, attempt: 0 })
  private epoch = 0
  private disposed = false
  private accepted = false
  private attempt = 0
  private stream: SessionControlStream | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closing: Promise<void> = Promise.resolve()

  /**
   * @param remote - Host session transport.
   * @param delays - Finite delays before successive service-unavailable retries.
   * @param accept - Apply control frames without clearing retained Session objects.
   * @param refresh - Pull and publish the authoritative list, returning its failure.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly delays: readonly number[],
    private readonly accept: (frame: SessionControlFrame) => void,
    private readonly refresh: () => Promise<RemoteFailure | null>,
  ) {}

  /** Start or manually retry with a fresh automatic retry budget. */
  retry(): void {
    if (this.disposed) return
    this.attempt = 0
    this.replace()
  }

  /**
   * Stop retries, fence pending callbacks, and await stream teardown.
   * @returns when no control iterator can publish another frame.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.epoch++
    this.close()
    await this.closing
  }

  private close(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) this.closing = this.closing.then(async () => { await stream.dispose() })
  }

  private replace(): void {
    const epoch = ++this.epoch
    this.close()
    this.publish(null)
    void this.closing.then(() => {
      if (!this.current(epoch)) return
      let baselineRevision = 0
      this.stream = createSessionControlStream(this.remote, {
        accept: (frame) => {
          if (!this.current(epoch)) return
          this.accept(frame)
          if (frame.type === 'baseline') {
            const revision = ++baselineRevision
            this.publish(null)
            void this.refresh().then((error) => {
              if (!this.current(epoch) || revision !== baselineRevision) return
              if (error !== null) { this.failed(error, epoch); return }
              this.accepted = true
              this.attempt = 0
              this.snapshot.set({ state: 'ready', error: null, attempt: 0 })
            }, (error: unknown) => {
              if (revision === baselineRevision) this.failed(error, epoch)
            })
          }
        },
        carrierFailed: (error) => {
          baselineRevision++
          if (this.current(epoch)) this.publish(new RemoteError('gateway/internal', error.message, {}))
        },
        failed: (error) => { this.failed(error, epoch) },
      })
      this.stream.start()
    })
  }

  private current(epoch: number): boolean {
    return !this.disposed && epoch === this.epoch
  }

  private publish(error: RemoteFailure | null): void {
    this.snapshot.set({
      state: this.accepted ? 'stale' : this.attempt === 0 ? 'loading' : 'retrying',
      error,
      attempt: this.attempt,
    })
  }

  private failed(value: unknown, epoch: number): void {
    if (!this.current(epoch)) return
    const error = remoteErrorOf(value) ?? new RemoteError(
      'gateway/internal', value instanceof Error ? value.message : String(value), {},
    )
    // Invalidate list completions from this attempt before the retry delay begins.
    this.epoch++
    this.close()
    const delay = error.code === 'gateway/service-unavailable' ? this.delays[this.attempt] : undefined
    if (delay === undefined) {
      this.snapshot.set({ state: this.accepted ? 'stale' : 'error', error, attempt: this.attempt })
      return
    }
    this.attempt++
    this.publish(error)
    this.timer = setTimeout(() => { this.replace() }, delay)
  }
}

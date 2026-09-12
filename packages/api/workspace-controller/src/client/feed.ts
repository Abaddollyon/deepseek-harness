/** Workspace-owned readiness recovery over the Gateway carrier lifecycle. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteFeedLifecycle, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientWorkspaceModel } from './model.ts'
import { createWorkspaceStateStream, type WorkspaceStateStream } from './transport.ts'

/** Credential-free diagnostics for one Workspace follow owner. */
export interface WorkspaceFeedSnapshot {
  readonly endpoint: 'workspace/follow'
  readonly state: 'loading' | 'retrying' | 'ready' | 'error' | 'closing'
  readonly attempt: number
  readonly generation: number
  readonly hasBaseline: boolean
  readonly lastSuccessfulAt: number | null
  readonly failure: 'service-unavailable' | 'terminal' | 'carrier' | 'teardown' | null
  readonly canRetry: boolean
}

/** Serializes Workspace subscriptions and fences callbacks before asynchronous teardown. */
export class WorkspaceFeedRecovery extends RemoteFeedLifecycle<WorkspaceStateStream> {
  /** Sanitized follow readiness diagnostics exposed to mounted client surfaces. */
  readonly snapshot = createSnapshotStore<WorkspaceFeedSnapshot>({
    endpoint: 'workspace/follow', state: 'loading', attempt: 0, generation: 0,
    hasBaseline: false, lastSuccessfulAt: null, failure: null, canRetry: false,
  })
  private attempt = 0
  private closeFailed = false

  /**
   * @param remote - Host Workspace carrier.
   * @param model - Retained Workspace projection.
   * @param delays - Finite temporary service-absence retry delays.
   */
  constructor(
    private readonly remote: ClientRemote,
    private readonly model: ClientWorkspaceModel,
    private readonly delays: readonly number[],
  ) { super() }

  /** A rejected teardown cannot prove quiescence; no replacement may open. */
  protected override readonly onCloseFailure = (): void => {
    this.closeFailed = true
    if (!this.disposed) {
      this.model.handleStreamFailure(new RemoteError('gateway/internal', 'Workspace subscription could not close', {}))
      this.publish('error', 'teardown', false)
    }
  }

  /** Start once or explicitly retry an exhausted temporary failure. Repeated clicks coalesce. */
  retry(): void {
    if (this.disposed || this.closeFailed || (this.epoch !== 0 && !this.snapshot.getSnapshot().canRetry)) return
    this.attempt = 0
    this.replace()
  }

  private publish(state: WorkspaceFeedSnapshot['state'], failure: WorkspaceFeedSnapshot['failure'] = null, canRetry = false): void {
    this.snapshot.set({ ...this.snapshot.getSnapshot(), state, failure, canRetry, attempt: this.attempt, generation: this.epoch })
  }

  private current(epoch: number): boolean { return !this.disposed && !this.closeFailed && epoch === this.epoch }

  private replace(): void {
    const epoch = ++this.epoch
    this.close()
    if (epoch > 1) this.model.handleCarrierFailure()
    this.publish('closing')
    void this.closing.then(() => {
      if (!this.current(epoch)) return
      this.publish(this.attempt === 0 ? 'loading' : 'retrying')
      if (!this.current(epoch)) return
      this.stream = createWorkspaceStateStream(this.remote, {
        accept: {
          replaceBaseline: (value) => {
            if (!this.current(epoch)) return
            this.model.replaceBaseline(value)
            this.attempt = 0
            this.snapshot.set({ endpoint: 'workspace/follow', state: 'ready', attempt: 0, generation: epoch, hasBaseline: true, lastSuccessfulAt: Date.now(), failure: null, canRetry: false })
          },
          upsertView: (value) => { if (this.current(epoch)) this.model.upsertView(value) },
          removeView: (value) => { if (this.current(epoch)) this.model.removeView(value) },
          replaceOrder: (value) => { if (this.current(epoch)) this.model.replaceOrder(value) },
          replaceArchived: (value) => { if (this.current(epoch)) this.model.replaceArchived(value) },
        },
        carrierFailed: () => {
          if (!this.current(epoch)) return
          this.model.handleCarrierFailure()
          this.publish('loading', 'carrier')
        },
        failed: (value) => {
          if (!this.current(epoch)) return
          const error = remoteErrorOf(value) ?? new RemoteError('gateway/internal', 'Workspace subscription failed', {})
          this.epoch++
          this.close()
          const temporary = error.code === 'gateway/service-unavailable'
          const delay = temporary ? this.delays[this.attempt] : undefined
          if (delay === undefined) {
            this.model.handleStreamFailure(error)
            this.publish('error', temporary ? 'service-unavailable' : 'terminal', temporary)
            return
          }
          this.attempt++
          this.model.handleCarrierFailure()
          this.publish('retrying', 'service-unavailable')
          this.timer = setTimeout(() => { if (!this.disposed && !this.closeFailed) this.replace() }, delay)
        },
      })
      this.stream.start()
    })
  }
}

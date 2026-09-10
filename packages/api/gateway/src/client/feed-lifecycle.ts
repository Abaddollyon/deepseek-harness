/** Retry-timer ownership and ordered teardown shared by Client feed recovery owners. */

/**
 * Fences a feed before teardown and serializes disposal across replacement streams.
 * Subclasses own retry admission, readiness, and callback generation checks.
 */
// Subclasses start their concrete stream after installing it.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export abstract class RemoteFeedLifecycle<Stream extends { dispose(): Promise<void> }> {
  protected epoch = 0
  protected disposed = false
  protected stream: Stream | undefined
  protected timer: ReturnType<typeof setTimeout> | undefined
  protected closing: Promise<void> = Promise.resolve()
  /** A handler absorbs teardown failure; its owner must block unsafe replacements. */
  protected onCloseFailure: ((error: unknown) => void | Promise<void>) | undefined

  /**
   * Stop retries and fence pending callbacks before awaiting stream teardown.
   * Without an owner failure handler, a teardown rejection remains rejected.
   * @returns when queued teardown, including owner failure handling, settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.epoch++
    this.close()
    await this.closing
  }

  /** Cancel retries, detach the active stream, and queue its teardown once. */
  protected close(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const stream = this.stream
    this.stream = undefined
    if (stream === undefined) return
    const closing = this.closing.then(() => stream.dispose())
    this.closing = this.onCloseFailure === undefined ? closing : closing.catch(this.onCloseFailure)
  }
}

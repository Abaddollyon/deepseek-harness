import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, JobRegistry, PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs'
import type {
  JobAdoptedListener, JobDoneListener, JobRead, JobSnapshot, JobStart, JobsChangedListener,
} from '@deepseek-ai/dsh-jobs'

/**
 * Minimal concrete registry: one canned record. The Service Definition owns the contract
 * only (ids, snapshots, authorization-shaped signatures); the registry
 * behavior suite lives with `@deepseek-ai/dsh-jobs-local`.
 */
class StubJobRegistry extends JobRegistry {
  snapshotOf(id: JobId): JobSnapshot {
    return {
      id,
      ordinal: 1,
      kind: 'bash',
      label: 'sleep 60',
      status: 'running',
      resumable: false,
      incarnation: PROCESS_INCARNATION,
      startedAt: 0,
      reported: false,
    }
  }

  start(spec: JobStart): JobId {
    spec.run()
    return JobId(`${spec.kind}-1`)
  }

  list(): JobSnapshot[] {
    return [this.snapshotOf(JobId('bash-1'))]
  }

  get(id: JobId): JobSnapshot {
    return this.snapshotOf(id)
  }

  read(id: JobId): JobRead {
    return { text: '', snapshot: this.snapshotOf(id) }
  }

  kill(): 'requested' | 'already-finished' {
    return 'requested'
  }

  wait(id: JobId, _timeoutMs: number, _caller?: Agent, _signal?: AbortSignal): Promise<JobSnapshot> {
    return Promise.resolve(this.snapshotOf(id))
  }

  onJobDone(_listener: JobDoneListener): () => void {
    return () => {}
  }

  onJobsChanged(_listener: JobsChangedListener): () => void {
    return () => {}
  }

  onJobAdopted(_listener: JobAdoptedListener): () => void {
    return () => {}
  }

  registerResumer(): () => void {
    return () => {}
  }

  attachController(_name: string): () => void {
    return () => {}
  }
}

describe('PROCESS_INCARNATION', () => {
  it('is one stable uuid per process, shared by every importer', () => {
    expect(PROCESS_INCARNATION).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('JobRegistry seam', () => {
  it('a concrete subclass registers as ctx.jobs and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubJobRegistry)

    const detachController = ctx.jobs.attachController('seam-test')
    const id = ctx.jobs.start({ kind: 'bash', label: 'sleep 60', run: () => ({ cancel() {}, done: new Promise(() => {}) }) })
    expect(id).toBe('bash-1')
    expect(ctx.jobs.list()).toHaveLength(1)
    expect(ctx.jobs.get(id).status).toBe('running')
    expect(ctx.jobs.read(id).text).toBe('')
    expect(ctx.jobs.kill(id)).toBe('requested')
    await expect(ctx.jobs.wait(id, 5)).resolves.toMatchObject({ id })
    const detachListener = ctx.jobs.onJobDone(() => {})
    detachListener()
    const detachChanges = ctx.jobs.onJobsChanged(() => {})
    detachChanges()
    const detachResumer = ctx.jobs.registerResumer('bash', () => undefined)
    detachResumer()
    detachController()
  })

  it('loading a second implementation throws (one jobs service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubJobRegistry)
    class SecondJobRegistry extends StubJobRegistry {}
    await expect(ctx.plugin(SecondJobRegistry)).rejects.toThrow(/service "jobs" has been registered/)
  })

  it('mounting the abstract seam directly fails loudly at load (stale-composition fence)', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(JobRegistry as unknown as typeof StubJobRegistry))
      .rejects.toThrow(/abstract job registry seam; load an implementation such as @deepseek-ai\/dsh-jobs-local/)
  })
})

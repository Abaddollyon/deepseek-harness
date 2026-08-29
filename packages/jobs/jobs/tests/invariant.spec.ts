import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import JobRegistry, { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobDoneListener, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import * as JobsInvariant from '@deepseek-ai/dsh-jobs/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const BASE: JobSnapshot = {
  id: JobId('bash-8c54d7a4-88ff-4bff-9df3-cb1b86d1c583'),
  ordinal: 1,
  kind: 'bash',
  label: 'compile',
  status: 'completed',
  resumable: false,
  incarnation: 'proc-1',
  startedAt: 10,
  finishedAt: 20,
  reported: false,
}

const { finishedAt: _baseFinishedAt, ...UNFINISHED } = BASE

const RUNNING: JobSnapshot = {
  ...UNFINISHED,
  status: 'running',
}

const TERMINAL_WITHOUT_FINISH: JobSnapshot = {
  ...UNFINISHED,
}

async function setup(seed: JobSnapshot[] = []): Promise<(snapshot: unknown, owner?: Agent) => void> {
  const ctx = new Context()
  let listener: JobDoneListener | undefined
  const probe = {
    list: () => seed,
    onJobDone(value: JobDoneListener) {
      listener = value
      return () => { listener = undefined }
    },
  } as unknown as JobRegistry
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({
    name: 'job-invariant-probe',
    apply(child: Context) { child.provide('jobs', probe) },
  })
  await ctx.plugin(JobsInvariant)
  if (listener === undefined) throw new Error('job invariant did not subscribe to terminal snapshots')
  return (snapshot, owner) => { listener!(snapshot as JobSnapshot, owner) }
}

describe('job-registry invariants', () => {
  it('accepts coherent current and terminal snapshots', async () => {
    const notify = await setup([RUNNING])
    expect(() => { notify(BASE) }).not.toThrow()
    const owner = { id: SessionId('owner') } as Agent
    expect(() => { notify({ ...BASE, id: JobId('subagent-2'), kind: 'subagent', ownerSession: owner.id }, owner) })
      .not.toThrow()
    // A restored record announces with an ownerSession but no live owner.
    expect(() => { notify({ ...BASE, ownerSession: SessionId('restored') }, undefined) }).not.toThrow()
  })

  it.each([
    [{ ...BASE, id: JobId('-1'), kind: '' }, undefined, /non-empty fragment/],
    [{ ...BASE, id: JobId('other-1') }, undefined, /must be "bash-" followed by a non-empty fragment/],
    [{ ...BASE, id: JobId('bash-') }, undefined, /non-empty fragment/],
    [{ ...BASE, ordinal: 0 }, undefined, /ordinal must be a positive integer/],
    [{ ...BASE, ordinal: 1.5 }, undefined, /ordinal must be a positive integer/],
    [{ ...BASE, incarnation: '' }, undefined, /incarnation must be non-empty/],
    [{ ...BASE, startedAt: -1 }, undefined, /startedAt must be a non-negative epoch integer/],
    [{ ...BASE, startedAt: 0.5 }, undefined, /startedAt must be a non-negative epoch integer/],
    [{ ...BASE, status: 'running' }, undefined, /finishedAt must be present exactly for a terminal status/],
    [TERMINAL_WITHOUT_FINISH, undefined, /finishedAt must be present exactly for a terminal status/],
    [{ ...BASE, finishedAt: 9 }, undefined, /no earlier than startedAt/],
    [{ ...BASE, finishedAt: 20.5 }, undefined, /no earlier than startedAt/],
    [{ ...BASE, ownerSession: SessionId('recorded') }, { id: SessionId('actual') } as Agent, /does not match its completion owner/],
  ] as const)('rejects an incoherent registry snapshot', async (snapshot, owner, message) => {
    const notify = await setup()
    expect(() => { notify(snapshot, owner) }).toThrow(message)
  })

  it('rejects an incoherent record already present at installation', async () => {
    await expect(setup([{ ...BASE, label: '' }])).rejects.toThrow(/label must be non-empty/)
  })
})

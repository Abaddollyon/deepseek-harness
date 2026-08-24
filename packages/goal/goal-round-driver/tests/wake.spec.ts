import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { hasPendingWork, isWakeSource } from '../src/wake.ts'

function source(value: object): MessageSource {
  return value as MessageSource
}

function agent(id: string, status: Agent['status'], parentSession?: string): Agent {
  return {
    id: SessionId(id),
    status,
    session: { header: { parentSession: parentSession === undefined ? undefined : SessionId(parentSession) } },
  } as Agent
}

function jobs(statuses: JobSnapshot['status'][]): JobRegistry {
  return {
    list: () => statuses.map(status => ({ status })) as JobSnapshot[],
  } as JobRegistry
}

describe('goal wake classification', () => {
  it.each([
    [{ kind: 'user' }, true],
    [{ kind: 'goal', goalId: 'goal', revision: 1, round: 1 }, false],
    [{ kind: 'plugin', plugin: 'tool-goal', form: 'notice', summary: 'goal changed' }, false],
    [{ kind: 'subagent-settled', form: 'notice', summary: 'child done' }, true],
    [{ kind: 'subagent-report', form: 'relay' }, true],
    [{ kind: 'plugin', plugin: 'context', form: 'instructions' }, false],
    [{ kind: 'plugin', plugin: 'context', form: 'snapshot' }, false],
    [{ kind: 'model' }, false],
  ] as const)('classifies %j as %s', (value, expected) => {
    expect(isWakeSource(source(value))).toBe(expected)
  })
})

describe('goal pending-work detection', () => {
  const owner = agent('owner', 'idle')

  it('detects only running direct children', () => {
    expect(hasPendingWork(owner, [
      owner,
      agent('running-child', 'running', 'owner'),
      agent('idle-child', 'idle', 'owner'),
      agent('other-child', 'running', 'other'),
    ], undefined)).toBe(true)
    expect(hasPendingWork(owner, [owner, agent('idle-child', 'idle', 'owner')], undefined)).toBe(false)
  })

  it.each([
    [[], false],
    [['completed'], false],
    [['running'], true],
    [['stopping'], true],
  ] as const)('classifies job statuses %j', (statuses, expected) => {
    expect(hasPendingWork(owner, [owner], jobs([...statuses]))).toBe(expected)
  })
})

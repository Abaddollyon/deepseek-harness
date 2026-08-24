// @vitest-environment jsdom
import { fireEvent, render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SubagentHeaderLineage, type SubagentHeaderLineageProps } from '../src/client/SubagentHeaderLineage.tsx'

afterEach(cleanup)
const sid = (id: string) => id as SessionId
const summary = (id: SessionId, extra: Partial<SessionSummary> = {}) => ({
  id, displayTitle: id, running: false, updatedAt: 0, ...extra,
}) as SessionSummary

describe('SubagentHeaderLineage catalog trigger', () => {
  it('opens the ordinary-session catalog when its count trigger is clicked', () => {
    const parent = sid('parent')
    const child = sid('child')
    const state = {
      ids: [parent, child], byId: { [parent]: summary(parent), [child]: summary(child, { origin: 'subagent', parentId: parent }) },
      current: parent, phase: 'ready', jobsBySession: {}, currentAddress: undefined,
      subagentsByParent: { [parent]: { state: 'ready', error: null, parentAvailable: true, entries: [{ kind: 'child', id: child, mode: 'continuable', activity: 'running', hasChildren: false }] } },
    } as unknown as SessionListState
    const calls: unknown[] = []
    const sessions = { getSnapshot: () => state, subscribe: () => () => {} }
    const view = render(<SubagentHeaderLineage {...({
      lineageSessionId: parent, displayTitle: 'parent', useSessions: bindSnapshotSelector(sessions),
      openChild: (address: SubagentAddress) => { calls.push(address) },
      refresh: (id: SessionId) => { calls.push(['refresh', id]) },
      setCatalogOpen: (id: SessionId, open: boolean) => { calls.push(['open', id, open]) },
      t: ((key: string) => key) as never,
    } as unknown as SubagentHeaderLineageProps)} />)
    const trigger = view.getByRole('button', { name: 'count.total.one' })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(calls).toContainEqual(['open', parent, true])
  })
})

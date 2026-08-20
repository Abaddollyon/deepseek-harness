// @vitest-environment jsdom
/** User-visible and lifecycle coverage for the unified session agent flow. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionId, type SessionListState, type SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentFlowView, type AgentFlowViewProps } from '../src/client/AgentFlowView.tsx'
import { zh } from '../src/client/locales.ts'

type CatalogEntry = SessionListState['subagentsByParent'][SessionId]['entries'][number]
const sid = (value: string) => value as SessionId
const ROOT = sid('root')

const t = ((key: string, values?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (match: string, name: string) => {
    const value = values?.[name]
    return value === undefined ? match : typeof value === 'string' ? value : JSON.stringify(value) ?? match
  })
}) as AgentFlowViewProps['t']

function summary(id: string, parentId: string | undefined, extra: Record<string, unknown> = {}): SessionSummary {
  return {
    id: sid(id),
    parentId: parentId === undefined ? undefined : sid(parentId),
    origin: 'subagent',
    displayTitle: id,
    running: false,
    updatedAt: 0,
    ...extra,
  } as unknown as SessionSummary
}

function catalog(entries: readonly CatalogEntry[], state: 'loading' | 'ready' | 'error' = 'ready'): SessionListState['subagentsByParent'][SessionId] {
  return { entries: [...entries], parentAvailable: true, state, error: null }
}

function child(id: string, mode: 'one-shot' | 'continuable' = 'continuable', extra: Record<string, unknown> = {}): CatalogEntry {
  return {
    kind: 'child',
    id: sid(id),
    activity: 'running',
    directActivity: 'running',
    hasChildren: false,
    mode,
    label: id,
    ...extra,
  }
}

function diagnostic(id: string, reason: 'corrupt' | 'unsupported' | 'unavailable'): CatalogEntry {
  return { kind: 'diagnostic', id: sid(id), reason }
}

function state({
  ids = [ROOT],
  summaries = {},
  catalogs = {},
}: {
  ids?: SessionId[]
  summaries?: Record<SessionId, SessionSummary>
  catalogs?: Readonly<Record<SessionId, SessionListState['subagentsByParent'][SessionId]>>
} = {}): SessionListState {
  return {
    ids,
    byId: summaries,
    current: ROOT,
    phase: 'ready',
    subagentsByParent: catalogs,
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
}

function renderFlow(snapshot: SessionListState, callbacks: Partial<AgentFlowViewProps> = {}) {
  const store = createSnapshotStore(snapshot)
  const props = {
    sessionId: ROOT,
    useSessions: bindSnapshotSelector(store),
    t,
    openChild: vi.fn(),
    openSession: vi.fn(),
    addressOf: vi.fn(),
    refresh: vi.fn(),
    setCatalogOpen: vi.fn(),
    ...callbacks,
  } as unknown as AgentFlowViewProps
  return { ...render(<AgentFlowView {...props} />), props, store }
}

afterEach(cleanup)

describe('AgentFlowView', () => {
  it('renders an empty state for a session without descendants', () => {
    renderFlow(state())

    expect(screen.getByRole('heading', { name: 'Agent 流程' })).toBeTruthy()
    expect(screen.getByRole('tree')).toBeTruthy()
    expect(screen.getByText('当前会话没有子代理后代')).toBeTruthy()
  })

  it('merges summary lineage and nested catalogs with accessible rows and addressed navigation', () => {
    const childSummary = summary('child-1', 'root', {
      running: false,
      projectionValues: {
        modelRoute: { provider: 'provider-a', model: 'model-a' },
        tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
        subagentTiming: { settledMs: 0, active: { since: 1_000, through: 3_000 } },
        sessionStats: { turns: 2, steps: 3 },
      },
    })
    const nestedSummary = summary('child-2', 'child-1')
    const openChild = vi.fn()
    const setCatalogOpen = vi.fn()
    renderFlow(state({
      summaries: { [sid('child-1')]: childSummary, [sid('child-2')]: nestedSummary },
      catalogs: {
        [ROOT]: catalog([child('child-1', 'continuable', { hasChildren: true })]),
        [sid('child-1')]: catalog([child('child-2', 'one-shot')]),
      },
    }), { openChild, setCatalogOpen })
    setCatalogOpen.mockClear()

    const first = screen.getByRole('treeitem', { name: /child-1/ })
    expect(first.getAttribute('aria-level')).toBe('1')
    expect(first.getAttribute('data-flow-id')).toBe('child-1')
    expect(first.getAttribute('data-flow-depth')).toBe('0')
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(first.getAttribute('aria-label')).toMatch(/provider-a \/ model-a/)
    expect(first.getAttribute('aria-label')).toMatch(/100 tokens/)
    expect(first.getAttribute('aria-label')).toMatch(/2秒/)
    expect(screen.getAllByText('100 tokens')).toHaveLength(2)
    expect(screen.getByText('2 轮 · 3 步')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '展开 child-1 的下级子代理' }))
    expect(setCatalogOpen).toHaveBeenCalledWith(sid('child-1'), true)
    const nested = screen.getByRole('treeitem', { name: /child-2/ })
    expect(nested.getAttribute('aria-level')).toBe('2')
    expect(nested.getAttribute('data-flow-depth')).toBe('1')

    fireEvent.click(first)
    expect(openChild).toHaveBeenCalledWith({
      parentSessionId: ROOT,
      childSessionId: sid('child-1'),
      mode: 'continuable',
    })
  })

  it('keeps catalog-first placeholders in the aggregate and makes diagnostics inert', () => {
    const openChild = vi.fn()
    const snapshot = state({
      summaries: {},
      catalogs: {
        [ROOT]: catalog([
          child('catalog-only', 'continuable', { label: 'catalog worker' }),
          diagnostic('broken', 'corrupt'),
          diagnostic('old', 'unsupported'),
          diagnostic('offline', 'unavailable'),
        ]),
      },
    })
    renderFlow(snapshot, { openChild })

    expect(screen.getByText('1 个子代理')).toBeTruthy()
    const healthy = screen.getByRole('treeitem', { name: /catalog worker/ })
    expect(healthy.getAttribute('data-flow-id')).toBe('catalog-only')
    expect(healthy.getAttribute('aria-disabled')).not.toBe('true')
    const diagnostics = screen.getAllByRole('treeitem', { name: /会话记录|子代理记录/ })
    expect(diagnostics).toHaveLength(3)
    for (const row of diagnostics) expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button', { name: '打开 broken' })).toBeNull()
    expect(openChild).not.toHaveBeenCalled()
  })

  it('shows summary-backed loading rows before catalog hydration', () => {
    const childSummary = summary('pending-child', 'root', { running: true })
    const snapshot = state({ summaries: { [sid('pending-child')]: childSummary } })
    const { props } = renderFlow(snapshot)

    const row = screen.getByRole('treeitem', { name: /pending-child/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.getAttribute('data-flow-id')).toBe('pending-child')
    expect(screen.getByText('正在加载子代理')).toBeTruthy()
    expect(props.setCatalogOpen).toHaveBeenCalledWith(ROOT, true)
  })

  it('renders a catalog load diagnostic with a localized retry action', () => {
    const refresh = vi.fn()
    renderFlow(state({ catalogs: { [ROOT]: catalog([], 'error') } }), { refresh })

    expect(screen.getByText('无法加载子代理')).toBeTruthy()
    const retry = screen.getByRole('button', { name: '重试' })
    fireEvent.click(retry)
    expect(refresh).toHaveBeenCalledWith(ROOT)
    expect(screen.getByRole('treeitem').getAttribute('aria-disabled')).toBe('true')
  })

  it('detects a lineage cycle without exposing an open action', () => {
    const snapshot = state({
      summaries: { [sid('cycle')]: summary('cycle', 'root') },
      catalogs: {
        [ROOT]: catalog([child('cycle', 'continuable', { hasChildren: true })]),
        [sid('cycle')]: catalog([child('cycle')]),
      },
    })
    const { props } = renderFlow(snapshot)
    fireEvent.click(screen.getByRole('button', { name: '展开 cycle 的下级子代理' }))

    const cycle = screen.getAllByRole('treeitem').at(-1)
    expect(cycle?.getAttribute('aria-disabled')).toBe('true')
    expect(cycle?.getAttribute('aria-label')).toMatch(/子代理血缘存在循环/)
    expect(props.openChild).not.toHaveBeenCalled()
  })
})

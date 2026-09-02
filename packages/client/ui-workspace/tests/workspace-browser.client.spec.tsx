// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot as WorkspaceListState, WorkspaceView, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear(); createWorkspaceViewStore().create().actions.setOrderBy('manual') })

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
// A durable title rides every summary by default: the title service is active,
// so the untitled directory-basename fallback is the exception, not the norm.
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
})
const sessionState = (items: readonly SessionSummary[], overrides: Partial<SessionListState> = {}): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  subagentsByParent: {}, jobsBySession: {},
  currentAddress: undefined,
  ...overrides,
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (items: readonly WorkspaceView[], archivedSessionIds: readonly SessionId[] = []): WorkspaceListState => ({
  items, archivedSessionIds, state: 'idle', phase: 'ready', error: null,
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', dropEffect: '' } })
  fireEvent(row, event)
}

function dragData(): Pick<DataTransfer, 'effectAllowed' | 'dropEffect' | 'setData'> {
  return { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn() }
}

function mount(overrides: Partial<WorkspaceBrowserProps> = {}) {
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState([])),
    useWorkspaces: hook(workspaceState([])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    createLooseSession: vi.fn(),
    open: vi.fn(),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
    renameSession: vi.fn(async () => {}),
    forkSession: vi.fn(),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}),
    insertSessionBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
    useHostInfo: hook({ home: undefined, isLoopback: true }),
    useSessionPendingInteraction: hook(new Map()),
    renderSlot: ((_name: string, owner: { open: boolean }) => (owner.open ? <div data-testid="directory-flow" /> : null)) as never,
    t,
    ...overrides,
  }
  const view = render(<WorkspaceBrowser {...props} />)
  return { view, props, store }
}

/** The group's header row, the element carrying its `aria-expanded` fold state. */
function groupHeader(label: string): HTMLElement {
  const header = screen.getByText(label).closest<HTMLElement>('[role="treeitem"]')
  if (header === null) throw new Error(`group "${label}" has no header row`)
  return header
}

/** Re-render with (possibly) changed props — WorkspaceBrowser has no side channel. */
function rerender(b: ReturnType<typeof mount>, overrides: Partial<WorkspaceBrowserProps>) {
  Object.assign(b.props, overrides)
  b.view.rerender(<WorkspaceBrowser {...b.props} />)
}

describe('WorkspaceBrowser', () => {
  it('workspace hover card shows a POSIX home descendant as ~', () => {
    vi.useFakeTimers()
    try {
      mount({
        useWorkspaces: hook(workspaceState([{
          ...workspace('project', []),
          path: '/home/u/Documents/project',
          title: 'Project',
        }])),
        useHostInfo: selector => selector({ home: '/home/u', isLoopback: true }),
      })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes deleted Workspace view state only after the Workspace baseline is ready', async () => {
    const pending = {
      ...workspaceState([]),
      phase: 'pending' as const,
      state: 'loading' as const,
    }
    const b = mount({ useWorkspaces: hook(pending) })
    act(() => {
      b.store.actions.setGroupExpanded('deleted', true)
      b.store.actions.syncSessionOrderAccount('deleted', ['session'], { session: 1 })
    })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ deleted: true })

    rerender(b, { useWorkspaces: hook(workspaceState([])) })
    await waitFor(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({})
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({ [UNGROUPED_KEY]: [] })
      expect(b.store.getSnapshot().sessionUpdatedAtByAccount).toEqual({ [UNGROUPED_KEY]: {} })
    })
  })

  it('renders the grouped tree by default and switches to the flat list via Group by', () => {
    const sessions = sessionState([summary('alpha-s', 2), summary('beta-s', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s']), workspace('beta', ['beta-s'])])),
    })
    expect(screen.getByText('工作区')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    // Sessions hidden while their group is folded.
    expect(screen.queryByText('alpha-s')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    expect(screen.getByText('分组方式')).toBeTruthy() // the menu heading label
    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '按工作区', '单列表', '手动排序', '最近更新',
    ])
    expect(screen.getByRole('menuitem', { name: '按工作区' }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '手动排序' }).querySelector('svg')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    // Store-driven flip: title changes, rows flatten newest-first, headers gone.
    expect(b.store.getSnapshot().groupBy).toBe('flat')
    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(screen.getByText('beta-s')).toBeTruthy()

    // Back to workspace grouping through the same menu.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    expect(screen.getByRole('menuitem', { name: '手动排序' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: '按工作区' }))
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
    expect(screen.getByText('工作区')).toBeTruthy()

    // Escape closes the menu without picking.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
  })

  it('renders sessions without durable titles as dated New Session rows, never as copies of the group label', () => {
    // The reported regression: every child row of a group read as the group's
    // own name. Those sessions carry no durable title, so their stored display
    // title is only the runtime's cwd-basename fallback — the workspace name.
    const untitled = (id: string, updatedAt: number): SessionSummary => ({
      id: sid(id), displayTitle: 'alpha', running: false, blank: false, updatedAt,
      cwd: '/projects/alpha',
    })
    const b = mount({
      useSessions: hook(sessionState([
        untitled('one', new Date(2026, 0, 2, 3, 4).getTime()),
        // Same minute as 'one': the dated labels collide, so the derivation
        // numbers both rows rather than letting them read identically.
        untitled('two', new Date(2026, 0, 2, 3, 4, 30).getTime()),
        untitled('three', new Date(2026, 0, 5, 6, 7).getTime()),
      ])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
    })
    fireEvent.click(screen.getByText('alpha'))

    // Every row label is non-empty, distinct from every sibling's, and
    // distinct from the group label, which appears exactly once — as the
    // group header.
    expect(screen.getByText('新会话 · 2026年1月2日 03:04（1）')).toBeTruthy()
    expect(screen.getByText('新会话 · 2026年1月2日 03:04（2）')).toBeTruthy()
    expect(screen.getByText('新会话 · 2026年1月5日 06:07')).toBeTruthy()
    expect(screen.getAllByText('alpha')).toHaveLength(1)
    // A durable title arriving on the same rows restores their real titles —
    // including one that legitimately IS the directory's own name.
    rerender(b, {
      useSessions: hook(sessionState([
        summary('one', 3, { title: 'Real one', displayTitle: 'Real one' }),
        summary('two', 2, { title: 'Real two', displayTitle: 'Real two' }),
        summary('three', 1, { title: 'alpha', displayTitle: 'alpha' }),
      ])),
    })
    expect(screen.getByText('Real one')).toBeTruthy()
    expect(screen.getByText('Real two')).toBeTruthy()
    // Header plus the genuinely directory-named row, nothing dated remains.
    expect(screen.getAllByText('alpha')).toHaveLength(2)
    expect(screen.queryByText(/新会话 · /)).toBeNull()
  })

  it('persists flat-list drag order locally and applies Last updated within that account', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const workspaces = workspaceState([
      workspace('alpha', ['one']),
      workspace('beta', ['two']),
    ])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaces),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })

    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const three = screen.getByText('three').closest('[role="treeitem"]') as HTMLElement
    three.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'three', 'one'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '手动排序' }))
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    b.view.unmount()

    const restored = mount({ useSessions: hook(sessions), useWorkspaces: hook(workspaces) })
    expect(restored.store.getSnapshot().groupBy).toBe('flat')
    expect(restored.store.getSnapshot().orderBy).toBe('manual')
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('expands a group on click and opens a session row', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      open,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha-s'))
    expect(open).toHaveBeenCalledWith(sid('alpha-s'))
    // Collapse hides the row again.
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('alpha-s')).toBeNull()
  })

  it('shows five sessions by default and clears transient show-all when the Workspace collapses', () => {
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    for (const item of items.slice(0, 5)) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.queryByText('session-7')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '展开其余 2 个会话' }))
    expect(screen.getByText('session-6')).toBeTruthy()
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()

    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: false })
    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 2 个会话' })).toBeTruthy()
  })

  it('keeps running sessions reachable through a collapse without inflating the overflow count', () => {
    // 8 members: 2 running. Folded shows the 2 live rows; expanded shows 5 plus
    // the overflow control for the remaining 3.
    const items = Array.from({ length: 8 }, (_, index) => summary(
      `session-${index + 1}`, 8 - index, index === 1 || index === 6 ? { running: true } : {},
    ))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })

    // Folded: only the live rows survive, and the remainder is counted honestly.
    expect(screen.getByText('session-2')).toBeTruthy()
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.queryByText('session-1')).toBeNull()
    expect(screen.getByText('另有 6 个会话已折叠')).toBeTruthy()
    // The overflow control belongs to the expanded list; pinned rows never feed it.
    expect(screen.queryByRole('button', { name: /展开其余|收起/ })).toBeNull()

    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    // Expanded: 8 rows minus the 5 shown = 3, unchanged by the pinning behavior,
    // and no live row is duplicated by its earlier pinned rendering.
    expect(screen.getByRole('button', { name: '展开其余 3 个会话' })).toBeTruthy()
    expect(screen.queryByText('另有 6 个会话已折叠')).toBeNull()
    expect(screen.getAllByText('session-2')).toHaveLength(1)
    expect(screen.queryByText('session-7')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开其余 3 个会话' }))
    expect(screen.getAllByText('session-7')).toHaveLength(1)
  })

  it('folds a group away entirely once its last live row stops running', () => {
    const running = sessionState([summary('busy', 2, { running: true }), summary('quiet', 1)])
    const b = mount({
      useSessions: hook(running),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['busy', 'quiet'])])),
    })
    expect(screen.getByText('busy')).toBeTruthy()
    expect(screen.getByText('另有 1 个会话已折叠')).toBeTruthy()

    // The pinned row is derived from the live snapshot, so it leaves with the run.
    rerender(b, { useSessions: hook(sessionState([summary('busy', 2, { completed: true }), summary('quiet', 1)])) })
    expect(screen.queryByText('busy')).toBeNull()
    expect(screen.queryByText('另有 1 个会话已折叠')).toBeNull()
  })

  it('shares one editable order across modes and promotes only while Last updated is active', async () => {
    const initial = sessionState([summary('one', 3), summary('two', 2)])
    const b = mount({
      useSessions: hook(initial),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      const rows = screen.getAllByRole('treeitem').slice(1)
      expect(rows[0]?.textContent).toContain('one')
      expect(rows[1]?.textContent).toContain('two')
    })

    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '手动排序' }))
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    // User activity updates the timestamp baseline in Manual mode without
    // changing the shared visual order.
    const updated = sessionState([summary('one', 4), summary('two', 2)])
    rerender(b, { useSessions: hook(updated) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionUpdatedAtByAccount.alpha).toEqual({ one: 4, two: 2 })
    })
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    // Entering Last updated performs one complete recency sort.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['one', 'two'])
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('one')
    })

    // A later user activity timestamp promotes that Session once while the
    // mode remains active.
    const promoted = sessionState([summary('one', 4), summary('two', 5)])
    rerender(b, { useSessions: hook(promoted) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
    })

    b.view.unmount()
    const restored = mount({
      useSessions: hook(promoted),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
  })

  it('archives a session from the row menu and hides archived rows in both modes', async () => {
    const archiveSession = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([summary('kept-s', 2), summary('gone-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '会话“gone-s”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
    expect(archiveSession).toHaveBeenCalledWith(sid('gone-s'))

    // The archive-set echo hides the row in grouped and flat modes.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])], [sid('gone-s')])) })
    expect(screen.queryByText('gone-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    expect(screen.getByText('kept-s')).toBeTruthy()
    expect(screen.queryByText('gone-s')).toBeNull()
  })

  it('pins a session from the row menu into a top Pinned section that renders it exactly once', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 2), summary('alpha-t', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s', 'alpha-t'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '会话“alpha-s”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶会话' }))
    expect(b.store.getSnapshot().pinnedSessionIds).toEqual(['alpha-s'])

    // The row left its group for the Pinned section: exactly one rendering,
    // and the section sits above every Workspace group.
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getAllByText('alpha-s')).toHaveLength(1)
    expect(screen.getByText('alpha-t')).toBeTruthy()
    const heading = screen.getByText('已置顶')
    const position = heading.compareDocumentPosition(screen.getByText('alpha'))
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('returns an unpinned session to its accounted group position', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 3), summary('alpha-t', 2), summary('alpha-u', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s', 'alpha-t', 'alpha-u'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    act(() => { b.store.actions.togglePinnedSession('alpha-t') })
    expect(screen.getAllByText('alpha-t')).toHaveLength(1)
    expect(screen.getByText('已置顶')).toBeTruthy()

    // Unpin from the Pinned section's own row menu; the row rejoins its group
    // at the accounted slot between its former neighbors.
    fireEvent.click(screen.getByRole('button', { name: '会话“alpha-t”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }))
    expect(b.store.getSnapshot().pinnedSessionIds).toEqual([])
    expect(screen.queryByText('已置顶')).toBeNull()
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('alpha-s'),
      expect.stringContaining('alpha-t'),
      expect.stringContaining('alpha-u'),
    ])
  })

  it('omits a pinned loose session from the Ungrouped bucket', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('loose-a', 2), summary('loose-b', 1)])),
      useWorkspaces: hook(workspaceState([])),
    })
    fireEvent.click(screen.getByText('未分组'))
    act(() => { b.store.actions.togglePinnedSession('loose-a') })
    expect(screen.getAllByText('loose-a')).toHaveLength(1)
    expect(screen.getByText('loose-b')).toBeTruthy()
    // The pinned row renders above the bucket header, inside the section.
    const position = screen.getByText('loose-a')
      .compareDocumentPosition(screen.getByText('未分组'))
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('omits pinned rows from the flat list and restores their manual position on unpin', async () => {
    const b = mount({
      useSessions: hook(sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])),
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })
    act(() => { b.store.actions.togglePinnedSession('two') })
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getAllByText('two')).toHaveLength(1)
    // The rendered flat list skips the pinned row; the order account keeps it.
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('one'),
      expect.stringContaining('three'),
    ])
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['one', 'two', 'three'])

    act(() => { b.store.actions.togglePinnedSession('two') })
    expect(screen.queryByText('已置顶')).toBeNull()
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('one'),
      expect.stringContaining('two'),
      expect.stringContaining('three'),
    ])
  })

  it('keeps a pinned session\'s flat position when another row is dragged', async () => {
    // The flat-order repair trap: drag edits must rewrite the full order
    // account, not the rendered rows — the rendered list omits pinned ids, so
    // a rows-derived write would silently drop the pinned thread's position.
    const b = mount({
      useSessions: hook(sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])),
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })
    act(() => { b.store.actions.togglePinnedSession('two') })

    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const three = screen.getByText('three').closest('[role="treeitem"]') as HTMLElement
    three.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'three', 'one'])

    act(() => { b.store.actions.togglePinnedSession('two') })
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('renders a pinned running session once — in the Pinned section, not under its folded group', () => {
    const b = mount({
      useSessions: hook(sessionState([
        summary('pinned-live', 3, { running: true }),
        summary('free-live', 2, { running: true }),
        summary('idle', 1),
      ])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['pinned-live', 'free-live', 'idle'])])),
    })
    act(() => { b.store.actions.togglePinnedSession('pinned-live') })
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getAllByText('pinned-live')).toHaveLength(1)
    // The folded group keeps its other live row as the automatic holdout and
    // counts only the sessions the fold still hides.
    expect(groupHeader('alpha').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('free-live')).toBeTruthy()
    expect(screen.getByText('另有 1 个会话已折叠')).toBeTruthy()
  })

  it('reveals a pinned current session\'s group without duplicating the pinned row', async () => {
    // Pins are seeded into the persisted view store before the browser mounts
    // (see the remount test below): the reveal then navigates into a session
    // that is already pinned.
    const seed = createWorkspaceViewStore().create()
    seed.actions.togglePinnedSession('cur-s')
    const b = mount({
      useSessions: hook(sessionState(
        [summary('cur-s', 2), summary('other-s', 1)],
        { current: sid('cur-s') },
      )),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['cur-s', 'other-s'])])),
    })
    expect(b.store.getSnapshot().pinnedSessionIds).toEqual(['cur-s'])
    // The reveal still opens the current session's group, but the pinned
    // current row renders exactly once — in the Pinned section.
    await waitFor(() => { expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true }) })
    expect(screen.getByText('other-s')).toBeTruthy()
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getAllByText('cur-s')).toHaveLength(1)
  })

  it('restores pinned threads from the persisted view store across a remount', () => {
    const seed = createWorkspaceViewStore().create()
    seed.actions.togglePinnedSession('one')
    const first = mount({
      useSessions: hook(sessionState([summary('one', 2), summary('two', 1)])),
    })
    expect(first.store.getSnapshot().pinnedSessionIds).toEqual(['one'])
    expect(screen.getByText('已置顶')).toBeTruthy()
    first.view.unmount()

    mount({ useSessions: hook(sessionState([summary('one', 2), summary('two', 1)])) })
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getAllByText('one')).toHaveLength(1)
    // The unpinned session is back in its (folded) bucket, not in the section.
    fireEvent.click(screen.getByText('未分组'))
    expect(screen.getByText('two')).toBeTruthy()
  })

  it('shows no empty-list placeholder while every session is pinned', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('only', 1)])),
    })
    act(() => { b.store.actions.togglePinnedSession('only') })
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getByText('only')).toBeTruthy()
    expect(screen.queryByText('暂无会话')).toBeNull()
  })

  it('logs and keeps the tree when the archive call rejects', async () => {
    const rejection = new Error('archive exploded')
    const archiveSession = vi.fn(async () => { throw rejection })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mount({
        useSessions: hook(sessionState([summary('alpha-s', 1)])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
        archiveSession,
      })
      fireEvent.click(screen.getByText('alpha'))
      fireEvent.click(screen.getByRole('button', { name: '会话“alpha-s”的操作' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith('session archive rejected:', rejection)
      expect(screen.getByText('alpha-s')).toBeTruthy()
    } finally {
      warn.mockRestore()
    }
  })

  it('renders a fork child as a top-level row without a session twist', () => {
    const parent = summary('parent-s', 2)
    const child = { ...summary('child-s', 1), parentId: parent.id }
    mount({
      useSessions: hook(sessionState([parent, child])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['parent-s', 'child-s'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('child-s')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull()
    expect(screen.getByText('child-s').closest('[role="treeitem"]')?.getAttribute('draggable')).toBe('true')
  })

  it('expands the target group before starting a session from its ＋', () => {
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      startSession,
    })
    startSession.mockImplementation(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    })
    expect(screen.queryByText('alpha-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在“alpha”中新建会话' }))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
  })

  it('reveals Ungrouped and creates a workspace-less live session from its ＋', async () => {
    const startSession = vi.fn()
    const createLooseSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('loose', 1)], { current: sid('loose') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      startSession,
      createLooseSession,
    })
    // The bucket is a group like any other: navigating into it opens it, and
    // the persisted fold bit records that.
    await waitFor(() => { expect(screen.getByText('loose')).toBeTruthy() })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ [UNGROUPED_KEY]: true })
    expect(screen.queryByRole('button', { name: '工作区“未分组”的操作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在“未分组”中新建会话' }))
    expect(startSession).not.toHaveBeenCalled()
    expect(createLooseSession).toHaveBeenCalledOnce()
  })

  it('opens the current session\'s group on navigation and never re-opens it against a deliberate fold', async () => {
    const first = sessionState([summary('a', 2), summary('b', 1)], { current: sid('a') })
    const b = mount({
      useSessions: hook(first),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a', 'b'])])),
    })
    // Navigation opened the group; the persisted bit and the header agree.
    await waitFor(() => { expect(screen.getByText('a')).toBeTruthy() })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(groupHeader('alpha').getAttribute('aria-expanded')).toBe('true')

    // A deliberate fold of the current group stands: neither a re-render nor a
    // new sessions snapshot for the same selection bounces it back open.
    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: false })
    expect(groupHeader('alpha').getAttribute('aria-expanded')).toBe('false')
    rerender(b, { useSessions: hook({ ...first }) })
    await waitFor(() => { expect(screen.queryByText('a')).toBeNull() })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: false })
    expect(groupHeader('alpha').getAttribute('aria-expanded')).toBe('false')

    // Selecting the other session in that folded group is navigation again, so
    // the row it selected becomes reachable.
    rerender(b, { useSessions: hook({ ...first, current: sid('b') }) })
    await waitFor(() => { expect(screen.getByText('b')).toBeTruthy() })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(groupHeader('alpha').getAttribute('aria-expanded')).toBe('true')
    // A selection hop inside the now-open group writes nothing new.
    rerender(b, { useSessions: hook({ ...first, current: sid('a') }) })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
  })

  it('reveals the session of a freshly connected Workspace without a manual click', async () => {
    const b = mount()
    // The connect lands as the new Workspace plus the blank Session it created,
    // which the Host selects.
    const created = summary('fresh-blank', 5, { blank: true })
    rerender(b, {
      useSessions: hook(sessionState([created], { current: created.id })),
      useWorkspaces: hook(workspaceState([workspace('fresh', ['fresh-blank'])])),
    })
    await waitFor(() => { expect(screen.getByText('新会话')).toBeTruthy() })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ fresh: true })
    expect(groupHeader('fresh').getAttribute('aria-expanded')).toBe('true')
  })

  it('opens only the current session\'s group, leaving other folded groups pinning their live rows', async () => {
    const b = mount({
      useSessions: hook(sessionState([
        summary('alpha-idle', 3), summary('beta-live', 2, { running: true }), summary('beta-idle', 1),
      ], { current: sid('alpha-idle') })),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['alpha-idle']), workspace('beta', ['beta-live', 'beta-idle']),
      ])),
    })
    // The reveal is scoped to the navigation: only the current session's group
    // opens, and an idle current row is exactly the case pinning cannot serve.
    await waitFor(() => { expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true }) })
    expect(screen.getByText('alpha-idle')).toBeTruthy()
    expect(groupHeader('alpha').getAttribute('aria-expanded')).toBe('true')

    // beta keeps the folded behavior: its live row stays pinned, its idle row
    // stays counted, and its header keeps reporting the fold truthfully.
    expect(groupHeader('beta').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('beta-live')).toBeTruthy()
    expect(screen.queryByText('beta-idle')).toBeNull()
    expect(screen.getByText('另有 1 个会话已折叠')).toBeTruthy()
  })

  it('shows only the current blank session as the localized New Session, excluded from search', async () => {
    const currentBlank = summary('alpha-blank', 9, { blank: true })
    const staleBlank = summary('beta-blank', 8, { blank: true })
    const sessions = sessionState(
      [currentBlank, staleBlank],
      { current: currentBlank.id },
    )
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['alpha-blank']), workspace('beta', ['beta-blank']),
      ])),
    })
    // The blank row is the current session, so the navigation reveal opens
    // the group that renders it.
    await waitFor(() => { expect(screen.getByText('新会话')).toBeTruthy() })
    expect(screen.queryByText('alpha-blank')).toBeNull()
    expect(screen.queryByText('beta-blank')).toBeNull()

    rerender(b, { useSessions: hook({ ...sessions, current: staleBlank.id }) })
    expect(screen.getAllByText('新会话')).toHaveLength(1)
    b.store.actions.setGroupBy('flat')
    rerender(b, {})
    expect(screen.getAllByText('新会话')).toHaveLength(1)
    // Search excludes blank rows entirely — neither the canonical stored
    // title nor the localized display label participates in matching.
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'new session' } })
    expect(screen.queryByText('新会话')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: '新会话' } })
    expect(screen.queryByText('新会话')).toBeNull()
  })

  it('promotes the blank selected by New Session in its grouped and flat orders', async () => {
    const items = [
      summary('old', 100),
      summary('blank', 150, { blank: true }),
      summary('mid', 200),
    ]
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank', 'mid'])])),
      startSession,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'blank', 'mid'])
    })
    startSession.mockImplementation(() => {
      rerender(b, { useSessions: hook(sessionState(items, { current: sid('blank') })) })
    })
    fireEvent.click(screen.getByRole('button', { name: '在“alpha”中新建会话' }))
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old', 'mid'])
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['blank'])
    })
    b.store.actions.setGroupBy('flat')
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['blank', 'mid', 'old'])
    })
  })

  it('does not repeat blank promotion after a manual drag or the first prompt', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([
        summary('old', 100),
        summary('blank', 150, { blank: true }),
        summary('mid', 200),
      ], { current: sid('blank') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank', 'mid'])])),
      insertSessionBefore,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old', 'mid'])
    })
    const blank = screen.getByText('新会话').closest('[role="treeitem"]') as HTMLElement
    const mid = screen.getByText('mid').closest('[role="treeitem"]') as HTMLElement
    mid.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(blank, { dataTransfer: dragData() })
    fireDrag(mid, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'mid', 'blank'])
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('blank'), undefined)

    rerender(b, {
      useSessions: hook(sessionState([
        summary('old', 100),
        summary('blank', 150),
        summary('mid', 200),
      ], { current: sid('blank') })),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'mid', 'blank'])
    })
  })

  it('shows local metadata matches immediately, then clears back to the grouped tree', async () => {
    vi.useFakeTimers()
    try {
      const sessions = sessionState([
        summary('needle-row', 2, { displayTitle: 'Needle row' }),
        summary('other-row', 1, { displayTitle: 'Other row' }),
      ])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-row', 'other-row'])])),
      })
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
      fireEvent.change(input, { target: { value: 'needle' } })
      const resultTree = screen.getByRole('tree', { name: '搜索结果' })
      expect(screen.getByText('Needle row')).toBeTruthy()
      expect(screen.queryByText('Other row')).toBeNull()
      const status = screen.getByRole('status')
      expect(status.textContent).toBe('正在搜索会话历史…')
      expect(resultTree.contains(status)).toBe(false)

      fireEvent.change(input, { target: { value: 'zzz' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('无匹配会话')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
      expect(input.value).toBe('')
      expect(screen.getByRole('tree', { name: '会话' })).toBeTruthy()
      // Clicking the field row focuses the input (wide mode).
      fireEvent.click(input.parentElement as HTMLElement)
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses an empty search on outside click but keeps a non-empty query expanded', () => {
    mount()
    const search = screen.getByRole('button', { name: '搜索会话' })
    fireEvent.click(search)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    fireEvent.change(input, { target: { value: 'kept' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(input.value).toBe('kept')
  })

  it('adds Host content hits with context, shows the result bound, and opens without clearing the query', async () => {
    vi.useFakeTimers()
    try {
      const open = vi.fn()
      const searchSessions = vi.fn(async () => ({
        items: [{ sessionId: sid('body-hit'), snippet: '…the waterfall token appears here…' }],
        hasMore: true,
      }))
      mount({
        useSessions: hook(sessionState([
          summary('body-hit', 1, { displayTitle: 'Research notes' }),
        ])),
        useWorkspaces: hook(workspaceState([
          workspace('research', ['body-hit'], 'Research Workspace'),
        ])),
        open,
        searchSessions,
      })
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
      fireEvent.change(input, { target: { value: 'waterfall token' } })
      expect(screen.getByText('正在搜索会话历史…')).toBeTruthy()
      expect(screen.queryByText('Research notes')).toBeNull()

      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(searchSessions).toHaveBeenCalledWith('waterfall token', expect.any(AbortSignal))
      expect(screen.getByText('Research notes')).toBeTruthy()
      expect(screen.getByText('Research Workspace')).toBeTruthy()
      expect(screen.getByText('…the waterfall token appears here…')).toBeTruthy()
      expect(screen.getByText('仅显示前 20 条结果，请缩小搜索范围。')).toBeTruthy()
      fireEvent.click(screen.getByRole('treeitem'))
      expect(open).toHaveBeenCalledWith(sid('body-hit'))
      expect(input.value).toBe('waterfall token')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds programmatic search input to a schema-valid request without splitting an astral character', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => ({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
      expect(input.maxLength).toBe(500)
      fireEvent.change(input, { target: { value: 'y'.repeat(501) } })
      expect(input.value).toBe('y'.repeat(500))
      const expected = `prefix${'x'.repeat(493)}`
      fireEvent.change(input, {
        target: { value: `prefix\0${'x'.repeat(493)}😀tail` },
      })

      expect(input.value).toBe(expected)
      expect(input.value.length).toBe(499)
      expect(input.value).not.toContain('\0')
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(searchSessions).toHaveBeenCalledOnce()
      expect(searchSessions).toHaveBeenCalledWith(expected, expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local matches and shows a lightweight warning when Host search fails', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => { throw new Error('index unavailable') })
      mount({
        useSessions: hook(sessionState([
          summary('local-hit', 1, { displayTitle: 'Needle title' }),
        ])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['local-hit'])])),
        searchSessions,
      })
      fireEvent.change(screen.getByPlaceholderText('搜索会话…'), {
        target: { value: 'needle' },
      })
      expect(screen.getByText('Needle title')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Needle title')).toBeTruthy()
      expect(screen.getByText('内容搜索暂不可用，仅显示名称匹配。')).toBeTruthy()
      expect(screen.queryByText('无匹配会话')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a superseded request and ignores its stale result', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst!: (value: {
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }) => void
      const first = new Promise<{
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }>((resolve) => { resolveFirst = resolve })
      const searchSessions = vi.fn((query: string, _signal: AbortSignal) => query === 'first'
        ? first
        : Promise.resolve({
          items: [{ sessionId: sid('second-hit'), snippet: 'second excerpt' }],
          hasMore: false,
        }))
      mount({
        useSessions: hook(sessionState([
          summary('first-hit', 2, { displayTitle: 'Old result' }),
          summary('second-hit', 1, { displayTitle: 'Fresh result' }),
        ])),
        searchSessions,
      })
      const input = screen.getByPlaceholderText('搜索会话…')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      const firstSignal = searchSessions.mock.calls[0]?.[1] as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      fireEvent.change(input, { target: { value: 'second' } })
      expect(firstSignal.aborted).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Fresh result')).toBeTruthy()

      await act(async () => {
        resolveFirst({
          items: [{ sessionId: sid('first-hit'), snippet: 'stale excerpt' }],
          hasMore: false,
        })
        await Promise.resolve()
      })
      expect(screen.queryByText('Old result')).toBeNull()
      expect(screen.getByText('Fresh result')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a rejected request after it has been superseded', async () => {
    vi.useFakeTimers()
    try {
      let rejectFirst!: (reason: Error) => void
      const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
      const searchSessions = vi.fn((query: string) => query === 'first'
        ? first
        : Promise.resolve({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText('搜索会话…')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      fireEvent.change(input, { target: { value: 'second' } })
      await act(async () => {
        rejectFirst(new Error('stale failure'))
        await Promise.resolve()
      })
      expect(screen.queryByText('内容搜索暂不可用，仅显示名称匹配。')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the no-sessions empty state in both modes and resolves an empty search', async () => {
    vi.useFakeTimers()
    try {
      const b = mount()
      expect(screen.getByText('暂无会话')).toBeTruthy()
      b.store.actions.setGroupBy('flat')
      rerender(b, {})
      expect(screen.getByText('暂无会话')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'x' } })
      expect(screen.getByText('正在搜索会话历史…')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('无匹配会话')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail state renders icon controls that request expansion', () => {
    vi.useFakeTimers()
    try {
      const expandSidebar = vi.fn()
      const b = mount({ wide: false, expandSidebar })
      // No wide chrome in rail state.
      expect(screen.queryByText('工作区')).toBeNull()
      expect(screen.queryByPlaceholderText('搜索会话…')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
      // The wide flip mounts the input and focuses it after the slide.
      rerender(b, { wide: true })
      const input = screen.getByPlaceholderText('搜索会话…')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(input)
      // Wide search button is decorative (tabIndex -1, no expand call).
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the rail-opened search expanded when the initiating click reaches document', () => {
    vi.useFakeTimers()
    try {
      const b = mount({ wide: false })
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      rerender(b, { wide: true })
      // In the browser the rail click keeps bubbling to document after the
      // wide flip mounted the outside-click listener, with the unmounted rail
      // button as its target — outside searchRoot. It must not dismiss the
      // search it just opened.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: '搜索会话' }).getAttribute('aria-expanded')).toBe('true')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(screen.getByPlaceholderText('搜索会话…'))
      // The gesture has settled: outside clicks dismiss the search again.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: '搜索会话' }).getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail add-workspace raises the directory flow in place, with no menu and no expansion', () => {
    const expandSidebar = vi.fn()
    mount({ wide: false, expandSidebar, useWorkspaces: hook(workspaceState([workspace('alpha', [])])) })
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }))
    expect(expandSidebar).not.toHaveBeenCalled()
    // Adding is the header's only action, so the gesture IS that action: no
    // one-row popover, and existing workspaces stay in the tree below.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'alpha' })).toBeNull()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('hides the add button when no directory-flow occupant is composed', () => {
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => false, subscribe: () => () => {} }),
    })
    // Nothing to add with, so the header offers no dead button.
    expect(screen.queryByRole('button', { name: '添加工作区' })).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('uses the full expanded Workspace section when resolving a Workspace drop half', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    const sessions = sessionState(Array.from({ length: 5 }, (_, index) => summary(`beta-${index}`, index)))
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', sessions.ids),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    fireEvent.click(screen.getByText('beta'))
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let targetSection = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (targetSection.parentElement?.getAttribute('role') !== 'tree') {
      targetSection = targetSection.parentElement as HTMLElement
    }
    targetSection.getBoundingClientRect = () => ({
      top: 100, bottom: 300, left: 0, right: 200, width: 200, height: 200, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    // y=190 is below the header row but still in the top half of the whole
    // expanded section, so the target is before beta rather than after it.
    fireDrag(targetSection, 'drop', 190)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('draws the first Workspace insertion boundary on the scroll container', () => {
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
      ])),
    })
    const source = screen.getByText('beta').closest('[role="treeitem"]') as HTMLElement
    let firstSection = screen.getByText('alpha').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (firstSection.parentElement?.getAttribute('role') !== 'tree') {
      firstSection = firstSection.parentElement as HTMLElement
    }
    firstSection.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(firstSection, 'dragOver', 105)
    expect(firstSection.parentElement?.className).toContain('listTopDropActive')
    const marker = firstSection.parentElement?.previousElementSibling
    expect(marker?.className).toContain('listTopDropIndicator')
  })

  it('accepts a document-level drop and commits the last Workspace marker on drag end', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let target = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (target.parentElement?.getAttribute('role') !== 'tree') {
      target = target.parentElement as HTMLElement
    }
    target.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(target, 'dragOver', 105)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(source)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('drag reorder reports the anchor to insertSessionBefore and skips no-op drops', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const rows = screen.getAllByRole('treeitem').slice(1) // drop the group header
    const [one, , three] = rows as [HTMLElement, HTMLElement, HTMLElement]
    three.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34, x: 0, y: 200, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    // Drop on the top half of "three": insert one before three.
    fireDrag(three, 'dragOver', 205)
    fireDrag(three, 'drop', 205)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('three'))

    // Dropping right back onto its own position is a no-op — top half
    // (anchor = itself) and bottom half (anchor = the next root) alike.
    fireEvent.dragStart(one, { dataTransfer })
    one.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(one, 'drop', 130)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
  })

  it('persists Ungrouped drag order in both modes without writing a Host Workspace account', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('未分组'))

    const dragAfter = (sourceTitle: string, targetTitle: string): void => {
      const source = screen.getByText(sourceTitle).closest('[role="treeitem"]') as HTMLElement
      const target = screen.getByText(targetTitle).closest('[role="treeitem"]') as HTMLElement
      target.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      fireEvent.dragStart(source, { dataTransfer: dragData() })
      fireDrag(target, 'drop', 180)
    }

    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    dragAfter('two', 'one')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['three', 'one', 'two'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['one', 'two', 'three'])
    })
    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    b.view.unmount()
    const restored = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
      insertSessionBefore,
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('still sends the reorder when the dragged row left the group mid-drag', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    // The host dropped "one" from the workspace account while the drag is in
    // flight: the source index is gone but the drop still resolves its anchor.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['two'])])) })
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireDrag(two, 'drop', 155)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('two'))
  })

  it('drag end without a drop clears markers; bottom-half drop appends past the last row', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    fireEvent.dragEnd(one)
    // The drag ended: rows no longer accept drops.
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).not.toHaveBeenCalled()

    // Bottom half of the last row: append (anchor omitted).
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(two, 'dragOver', 180)
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('accepts a document-level drop and commits the last Session marker on drag end', () => {
    const insertSessionBefore = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('one', 2), summary('two', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'dragOver', 180)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(one)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('logs and keeps the order when the reorder call rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const insertSessionBefore = vi.fn(async () => { throw new Error('stale anchor') })
      const sessions = sessionState([summary('one', 2), summary('two', 1)])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
        insertSessionBefore,
      })
      fireEvent.click(screen.getByText('alpha'))
      const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
      two.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      const dataTransfer = dragData()
      fireEvent.dragStart(one, { dataTransfer })
      fireDrag(two, 'drop', 180)
      await waitFor(() => { expect(warn).toHaveBeenCalledWith('session reorder rejected:', expect.any(Error)) })
    } finally {
      warn.mockRestore()
    }
  })

  it('renames a workspace through the row menu dialog', async () => {
    let resolveRename!: () => void
    const renameWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha'), workspace('beta', [], 'Beta')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText<HTMLInputElement>('工作区名称')
    expect(input.value).toBe('Alpha')
    // Unchanged and blank names stay blocked.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    // A duplicate of another workspace's title shows the inline conflict.
    fireEvent.change(input, { target: { value: ' Beta ' } })
    expect(screen.getByRole('alert').textContent).toBe('已存在名为“Beta”的工作区。')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Gamma')
    // While renaming: input disabled, close blocked, Enter ignored.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rename via Enter, failure surfaces the error, Cancel closes', async () => {
    const renameWorkspace = vi.fn(async () => { throw new Error('rename conflict') })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText<HTMLInputElement>('工作区名称')
    // Enter with a blocked draft (unchanged) does nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Renamed')
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('rename conflict') })
    // The dialog stays for retry; typing clears the error; Cancel closes.
    fireEvent.change(input, { target: { value: 'Renamed2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error rename failures as text', async () => {
    const renameWorkspace = vi.fn(async () => { throw 'denied' })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('confirms Workspace deletion, explains retention, and blocks duplicate submission', async () => {
    let resolveDelete!: () => void
    const deleteWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    const browser = mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', ['session'], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    const dialog = screen.getByRole('dialog', { name: '删除工作区' })
    expect(dialog.textContent).toContain('将把“Alpha”从工作区列表中移除')
    expect(dialog.textContent).toContain('文件夹与会话记录会保留')
    expect(dialog.textContent).toContain('其会话将显示在“未分组”下')

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '删除工作区' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteWorkspace).toHaveBeenCalledOnce()
    expect(deleteWorkspace).toHaveBeenCalledWith(wid('alpha'))
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('正在删除工作区…')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    await act(async () => { resolveDelete() })
    // RPC success alone does not close: the component waits until its
    // useWorkspaces projection has committed the removal, preventing a stale
    // Workspace frame from leaking into the next gesture.
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    rerender(browser, { useWorkspaces: hook(workspaceState([])) })
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('keeps the delete dialog open on failure and allows retry or cancellation', async () => {
    const deleteWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce('denied')
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('storage unavailable') })
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('Cancel, Escape, and Close dismiss deletion without calling the action', () => {
    const deleteWorkspace = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    }
    open()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    open()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(deleteWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('search hides drag affordances (rows are not draggable during search)', () => {
    const sessions = sessionState([summary('needle-a', 2, { displayTitle: 'Needle A' })])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-a'])])),
    })
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'needle' } })
    const row = screen.getByText('Needle A').closest('[role="treeitem"]') as HTMLElement
    expect(row.hasAttribute('draggable')).toBe(false)
  })
})

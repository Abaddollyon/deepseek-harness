/**
 * Derives the workspace browser tree from Host Workspace order and membership.
 * Unassigned Sessions trail under Ungrouped; only the selected blank Session
 * remains visible.
 */
import { type SessionListState, type SessionSearchResultItem, type SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { indexSubagentDescendants, type SubagentDescendantSummary } from './subagent-lineage.ts'

type PendingInteractionStatus = 'approval' | 'plan-review' | 'question'
export type PendingInteractionSnapshot = ReadonlyMap<SessionId, { readonly kind: string }>

function pendingStatus(snapshot: PendingInteractionSnapshot, id: SessionId): PendingInteractionStatus | undefined {
  const kind = snapshot.get(id)?.kind
  return kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : undefined
}

function pendingFields(snapshot: PendingInteractionSnapshot, id: SessionId):
  | Record<never, never>
  | { readonly pendingInteraction: PendingInteractionStatus } {
  const status = pendingStatus(snapshot, id)
  return status === undefined ? {} : { pendingInteraction: status }
}

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped bucket row. */
/** Empty sentinel; renderers localize the Ungrouped label through their locale seat. */
export const UNGROUPED_LABEL = ''

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Stored display title; the renderer substitutes the localized New Session label for blank rows. */
  title: string
  /**
   * No durable title backs this row (logs predating the title service, or a
   * title projection that has not landed): the stored display title is only
   * the runtime's directory-basename fallback, identical for every session
   * sharing the workspace cwd. The renderer substitutes a dated New Session
   * label so untitled rows stay distinct from each other and from the group.
   * Absent = false.
   */
  untitled?: boolean
  /**
   * 1-based ordinal inside the set of untitled rows whose dated labels share
   * one minute stamp; present only when such a collision exists, so no two
   * rows of one list ever render identical text.
   */
  untitledNumber?: number
  /** The provisional blank session (renderer shows the localized New Session title). */
  blank: boolean
  /** The runtime Session list reports an interaction awaiting this user. */
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  updatedAt: number
  /** Whether a durable active schedule targets this session. */
  hasActiveSchedule?: boolean
}

/** Session order selected by the Workspace browser. */
export type SessionOrderBy = 'manual' | 'updated'

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
  /**
   * Live rows kept reachable while the group is folded, in the same order they
   * hold in {@link sessions}. Empty while the group is expanded, so a session
   * never appears in both arrays; reorder and overflow paths read
   * {@link sessions} only and therefore never target a pinned row.
   * This is the AUTOMATIC folded-group holdout — unrelated to user-pinned
   * threads ({@link TreeView.pinnedSessionIds}), which leave their group
   * entirely and render in the sidebar's Pinned section instead.
   */
  pinned: readonly SessionNode[]
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  /** The runtime Session list reports an interaction awaiting this user. */
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  snippet?: string
  /** Whether a durable active schedule targets this session. */
  hasActiveSchedule?: boolean
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedGroups: readonly string[]
  /** Browser-local order for Sessions without a backing Workspace account. */
  ungroupedOrder?: readonly string[]
  /**
   * User-pinned Session ids (explicit, reload-surviving pins): excluded from
   * every group and from the folded-group live holdout, so a pinned thread
   * renders exactly once — in the Pinned section derived by
   * {@link derivePinnedSessions}. Unrelated to {@link GroupNode.pinned}, the
   * automatic live-row holdout of a folded group.
   */
  pinnedSessionIds?: readonly string[]
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or the ungrouped label.
 */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return UNGROUPED_LABEL
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : cwd
}

/**
 * The group key whose section renders the selected Session's row: the
 * Workspace accounting for it, or the Ungrouped bucket when none does.
 * @param current - the selected Session.
 * @param workspaces - real workspaces in stable Host order.
 * @returns the workspace id as a group key, or {@link UNGROUPED_KEY}.
 */
export function currentGroupKey(current: SessionId, workspaces: readonly WorkspaceView[]): string {
  return (workspaces.find(w => w.sessionIds.includes(current))?.workspaceId as string | undefined) ?? UNGROUPED_KEY
}

/** Recency comparator: newest first, id as the deterministic tiebreak (ids are unique per group). */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * is visible. Subagent children use their parent header catalog; archived
 * sessions are visible nowhere, while their accounting slots remain so
 * unarchiving restores position.
 */
function sessionVisible(session: SessionSummary, current: SessionId | undefined, archived: ReadonlySet<SessionId>): boolean {
  return session.origin !== 'subagent'
    && !archived.has(session.id)
    && (!session.blank || session.id === current)
}

/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label.
 */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? '' : session.displayTitle
}

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
  order: 'account' | 'recency',
): Group {
  const sessions = [...members]
  // Real Workspace order comes from sessionIds. Ungrouped falls back to
  // recency until the browser supplies its persisted local order.
  if (order === 'recency') sessions.sort(byRecency)
  return { key, workspaceId, cwd, createdAt, label, sessions }
}

/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(members: readonly SessionSummary[], stored: readonly string[]): SessionSummary[] {
  const byId = new Map(members.map(session => [session.id as string, session]))
  const included = new Set<string>()
  const ordered: SessionSummary[] = []
  for (const key of stored) {
    const session = byId.get(key)
    if (session === undefined || included.has(key)) continue
    ordered.push(session)
    included.add(key)
  }
  for (const session of [...members].sort(byRecency)) {
    if (included.has(session.id)) continue
    ordered.push(session)
  }
  return ordered
}

/**
 * Group Sessions by Host Workspace: one group per entity in stable Host
 * order, with members resolved from sessionIds in their stored order. Sessions
 * outside every Workspace trail in the browser-local Ungrouped order, which
 * falls back to recency before that order is initialized.
 */
function groupByWorkspace(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  ungroupedOrder: readonly string[] | undefined,
  userPinned: ReadonlySet<string>,
): Group[] {
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      // User-pinned rows leave the group but keep their accounting slot, so
      // unpinning returns them to the same order position.
      if (!sessionVisible(summary, list.current, archived) || userPinned.has(id)) continue
      members.push(summary)
    }
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members, 'account',
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && !userPinned.has(s.id) && sessionVisible(s, list.current, archived))
  if (stray.length > 0) {
    groups.push(buildGroup(
      UNGROUPED_KEY,
      undefined,
      undefined,
      undefined,
      UNGROUPED_LABEL,
      ungroupedOrder === undefined ? stray : orderedUngrouped(stray, ungroupedOrder),
      ungroupedOrder === undefined ? 'recency' : 'account',
    ))
  }
  return groups
}

function sessionNode(
  s: SessionSummary,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
  pendingInteractions: PendingInteractionSnapshot,
): SessionNode {
  return {
    id: s.id,
    title: sessionTitle(s),
    untitled: !s.blank && s.title === undefined,
    blank: s.blank,
    running: s.running,
    runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
    completed: s.completed === true,
    updatedAt: s.updatedAt,
    ...pendingFields(pendingInteractions, s.id),
  }
}

/**
 * A row whose work is still in flight: its own run, or a run in a descendant
 * reached through uninterrupted subagent-origin lineage. The finished-but-unopened
 * reminder is a settled state and is deliberately excluded.
 */
function isLive(node: SessionNode): boolean {
  return node.running || node.runningSubagentCount > 0
}

/**
 * Number the untitled rows whose dated labels share one minute stamp. The
 * renderer's untitled label distinguishes rows by last-activity time alone,
 * so same-minute untitled siblings would render identical text; every member
 * of a collision set takes a 1-based ordinal in row order. The input array
 * returns unchanged (identity included) when no collision exists, and the
 * collision rule scopes to the rendered list — one group, or the flat view.
 * @param rows - one rendered row set in render order.
 * @returns the rows, with `untitledNumber` set on colliding untitled rows.
 */
function numberUntitledCollisions(rows: SessionNode[]): SessionNode[] {
  const minuteOf = (row: SessionNode): number => Math.floor(row.updatedAt / 60_000)
  const minutes = new Map<number, number>()
  for (const row of rows) {
    if (row.untitled !== true) continue
    const minute = minuteOf(row)
    minutes.set(minute, (minutes.get(minute) ?? 0) + 1)
  }
  if (![...minutes.values()].some(count => count > 1)) return rows
  const seen = new Map<number, number>()
  return rows.map((row) => {
    if (row.untitled !== true || minutes.get(minuteOf(row)) === 1) return row
    const minute = minuteOf(row)
    const n = (seen.get(minute) ?? 0) + 1
    seen.set(minute, n)
    return { ...row, untitledNumber: n }
  })
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows; sessions populate under expanded groups in the selected
 * local order. A folded group keeps no `sessions`, but still exposes its live
 * rows as `pinned` so running work never disappears behind a collapse. Blank
 * sessions are excluded except for the selected provisional New Session row;
 * archived sessions are excluded everywhere. User-pinned sessions
 * ({@link TreeView.pinnedSessionIds}) are excluded from every group — and from
 * the folded live holdout — because they render in the Pinned section
 * ({@link derivePinnedSessions}) instead.
 * Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order.
 * @param archivedSessionIds - registry-global archive set.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  view: TreeView,
  pendingInteractions: PendingInteractionSnapshot = new Map(),
): GroupNode[] {
  const archived = new Set(archivedSessionIds)
  const expandedGroups = new Set(view.expandedGroups)
  const userPinned = new Set<string>(view.pinnedSessionIds ?? [])
  const descendants = indexSubagentDescendants(list.byId)
  const currentGroup = list.current === undefined ? undefined : currentGroupKey(list.current, workspaces)
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder, userPinned)) {
    const expanded = expandedGroups.has(g.key)
    const rows = g.sessions.map(session => sessionNode(session, descendants, pendingInteractions))
    groups.push({
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      createdAt: g.createdAt,
      label: g.label,
      sessionCount: g.sessions.length,
      expanded,
      containsCurrent: g.key === currentGroup,
      sessions: expanded ? numberUntitledCollisions(rows) : [],
      // A user-pinned live session renders in the Pinned section instead; the
      // folded holdout must not surface it a second time under the header.
      pinned: expanded ? [] : numberUntitledCollisions(rows.filter(node => isLive(node) && !userPinned.has(node.id))),
    })
  }
  return groups
}

/**
 * Derive the sidebar Pinned section: user-pinned Sessions in explicit pin
 * order. Pins name threads, not groups, so one flat row set serves both the
 * grouped and the flat browsing modes. Ids whose summary is missing, blank,
 * or no longer visible (archived, subagent) are skipped in place — the stored
 * pin list is never rewritten here, so an archived pin revives on unarchive.
 * Unrelated to the folded-group live holdout ({@link GroupNode.pinned}).
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @param pinnedSessionIds - user-pinned Session ids in pin order.
 * @returns pinned rows in render order.
 */
export function derivePinnedSessions(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  pinnedSessionIds: readonly string[],
  pendingInteractions: PendingInteractionSnapshot = new Map(),
): SessionNode[] {
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)
  const rows: SessionNode[] = []
  for (const id of pinnedSessionIds) {
    const summary = list.byId[id as SessionId]
    // Blank rows are provisional placeholders and never carry the row menu,
    // so a blank id can only arrive through stale persisted pins.
    if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived)) continue
    rows.push(sessionNode(summary, descendants, pendingInteractions))
  }
  return numberUntitledCollisions(rows)
}

/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first. No grouping,
 * no parent/child adjacency. User-pinned sessions stay IN this result on
 * purpose: it feeds the flat order account, and dropping a pinned id there
 * would cost the thread its manual position on unpin — the renderer filters
 * pinned rows after the stored order is reconciled. Content search lives
 * outside this derivation (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns flat rows in render order.
 */
export function deriveFlat(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  pendingInteractions: PendingInteractionSnapshot = new Map(),
): SessionNode[] {
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)
  const rows: SessionSummary[] = []
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || !sessionVisible(s, list.current, archived)) continue
    rows.push(s)
  }
  rows.sort(byRecency)
  return numberUntitledCollisions(rows.map(session => sessionNode(session, descendants, pendingInteractions)))
}

/** Relative-time bucket of a session row's trailing label. */
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

/** Structured relative time: the bucket plus its magnitude (0 for 'now'). */
export interface RelativeTime {
  unit: RelativeTimeUnit
  n: number
}

/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members never match).
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
  pendingInteractions: PendingInteractionSnapshot = new Map(),
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)

  const workspaceBySession = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title)
    }
  }
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    // Blank placeholders never match a query (their canonical title displays
    // localized, so matching it would tie search to one language).
    if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  local.sort(byRecency)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of local) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && !summary.blank && sessionVisible(summary, list.current, archived)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: summary.running,
        runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
        completed: summary.completed === true,
        ...pendingFields(pendingInteractions, summary.id),
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/**
 * Compact relative time for session rows, as a structured bucket the
 * renderer localizes ("now"/"5min"/"3h"/"2d"/"4mo"/"1y" in en).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the row's trailing time bucket and magnitude.
 */
export function relativeTime(updatedAt: number, now: number): RelativeTime {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/** Pure merge model for the session-scoped subagent flow view. */
import { indexSubagentDescendants, type SessionId, type SessionListState, type SessionProjectionMap, type SessionSummary, type SubagentAddress, type SubagentCatalogSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { tokenTotal } from './subagent-metrics.ts'

type Catalogs = SessionListState['subagentsByParent']
type CatalogSnapshot = Catalogs[SessionId]
type CatalogEntry = SubagentCatalogSnapshot['entries'][number]
type ChildCatalogEntry = Extract<CatalogEntry, { kind: 'child' }>
type TimingProjection = SessionProjectionMap['subagentTiming']
type StatsProjection = SessionProjectionMap['sessionStats']
type DescendantIndex = ReturnType<typeof indexSubagentDescendants>

/** Why a disabled flow row cannot be opened. */
export type FlowDiagnosticReason =
  | 'corrupt'
  | 'unsupported'
  | 'unavailable'
  | 'cycle'
  | 'load-error'

/** A pure row in the expanded portion of the flow tree. */
export interface AgentFlowRow {
  readonly key: string
  readonly id: SessionId
  readonly parentSessionId: SessionId
  readonly depth: number
  readonly kind: 'child' | 'diagnostic' | 'loading'
  readonly label: string
  readonly mode: 'one-shot' | 'continuable' | undefined
  readonly activity: 'running' | 'inactive'
  readonly hasChildren: boolean
  readonly runningDescendantCount: number
  readonly summary: SessionSummary | undefined
  readonly catalogEntry: ChildCatalogEntry | undefined
  readonly diagnostic: FlowDiagnosticReason | undefined
  readonly address: SubagentAddress | undefined
  readonly ordinaryOpenable: boolean
  readonly canOpen: boolean
  readonly needsRefresh: boolean
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly agentPreset: string | undefined
  readonly timing: TimingProjection | undefined
  readonly stats: StatsProjection | undefined
  readonly tokenTotal: number | undefined
  readonly children: readonly AgentFlowRow[]
}

/** Aggregate facts for the root session, including catalog-only children. */
export interface AgentFlowAggregate {
  readonly totalCount: number
  readonly runningCount: number
  readonly settledCount: number
  readonly tokenTotal: number | undefined
}

/** Complete pure model consumed by the flow renderer. */
export interface AgentFlowModel {
  readonly rows: readonly AgentFlowRow[]
  readonly aggregate: AgentFlowAggregate
}

/** Inputs needed to merge retained summaries and direct catalog snapshots. */
export interface AgentFlowModelOptions {
  readonly rootSessionId: SessionId
  readonly summaries: Readonly<Record<SessionId, SessionSummary>>
  readonly catalogs: Catalogs
  readonly expanded: ReadonlySet<SessionId>
  readonly ordinaryOpenableIds: ReadonlySet<SessionId>
  readonly addressOf: (id: SessionId) => SubagentAddress | undefined
}

interface ChildSource {
  readonly id: SessionId
  summary: SessionSummary | undefined
  readonly catalogEntry: ChildCatalogEntry | undefined
  readonly diagnostic: Extract<CatalogEntry, { kind: 'diagnostic' }> | undefined
  readonly syntheticDiagnostic?: FlowDiagnosticReason | undefined
  readonly loading: boolean
}

function summaryLabel(summary: SessionSummary | undefined, catalogLabel: string | undefined, id: SessionId): string {
  const title = summary?.title?.trim()
  if (title !== undefined && title.length > 0) return title
  const label = catalogLabel?.trim()
  if (label !== undefined && label.length > 0) return label
  const displayTitle = summary?.displayTitle.trim()
  return displayTitle === undefined || displayTitle.length === 0 ? id : displayTitle
}

function directChildren(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): ReadonlyMap<SessionId, readonly SessionSummary[]> {
  const children = new Map<SessionId, SessionSummary[]>()
  for (const summary of Object.values(summaries)) {
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    const siblings = children.get(summary.parentId) ?? []
    siblings.push(summary)
    children.set(summary.parentId, siblings)
  }
  return children
}

function childEntries(
  parentSessionId: SessionId,
  catalogs: Catalogs,
  summaries: ReadonlyMap<SessionId, readonly SessionSummary[]>,
): readonly ChildSource[] {
  const catalog = catalogs[parentSessionId]
  const summaryChildren = summaries.get(parentSessionId) ?? []
  // Catalog sources by id: summary merging below is a Map hit, not a linear
  // scan per summary child (wide fan-outs made that quadratic).
  const catalogSources = new Map<SessionId, ChildSource>()
  const sources: ChildSource[] = []
  for (const entry of catalog?.entries ?? []) {
    const source: ChildSource = entry.kind === 'diagnostic'
      ? {
        id: entry.id,
        summary: undefined,
        catalogEntry: undefined,
        diagnostic: entry,
        loading: false,
      }
      : {
        id: entry.id,
        summary: undefined,
        catalogEntry: entry,
        diagnostic: undefined,
        loading: catalog?.state === 'loading' && catalog.entries.length === 0,
      }
    if (!catalogSources.has(entry.id)) catalogSources.set(entry.id, source)
    sources.push(source)
  }
  const loading = catalog === undefined
    || (catalog.state === 'loading' && catalog.entries.length === 0)
    || (catalog.state === 'ready' && catalog.entries.length === 0 && summaryChildren.length > 0)
    || (catalog.state === 'error' && catalog.entries.length === 0 && summaryChildren.length > 0)
  for (const summary of summaryChildren) {
    const existing = catalogSources.get(summary.id)
    if (existing !== undefined) {
      existing.summary = summary
      continue
    }
    sources.push({
      id: summary.id,
      summary,
      catalogEntry: undefined,
      diagnostic: undefined,
      loading,
    })
  }
  if (catalog?.state === 'loading' && sources.length === 0) {
    return [{
      id: parentSessionId,
      summary: undefined,
      catalogEntry: undefined,
      diagnostic: undefined,
      loading: true,
    }]
  }
  if (catalog?.state === 'error') {
    sources.push({
      id: parentSessionId,
      summary: undefined,
      catalogEntry: undefined,
      diagnostic: undefined,
      syntheticDiagnostic: 'load-error',
      loading: false,
    })
  }
  return sources
}

function diagnosticRow(
  parentSessionId: SessionId,
  id: SessionId,
  depth: number,
  reason: FlowDiagnosticReason,
  label: string,
): AgentFlowRow {
  return {
    key: `diagnostic:${parentSessionId}:${reason}:${id}`,
    id,
    parentSessionId,
    depth,
    kind: 'diagnostic',
    label,
    mode: undefined,
    activity: 'inactive',
    hasChildren: false,
    runningDescendantCount: 0,
    summary: undefined,
    catalogEntry: undefined,
    diagnostic: reason,
    address: undefined,
    ordinaryOpenable: false,
    canOpen: false,
    needsRefresh: false,
    provider: undefined,
    model: undefined,
    agentPreset: undefined,
    timing: undefined,
    stats: undefined,
    tokenTotal: undefined,
    children: [],
  }
}

function loadingRow(parentSessionId: SessionId, id: SessionId, depth: number, summary?: SessionSummary): AgentFlowRow {
  return {
    key: id,
    id,
    parentSessionId,
    depth,
    kind: 'loading',
    label: summaryLabel(summary, undefined, id),
    mode: undefined,
    activity: summary?.running === true ? 'running' : 'inactive',
    hasChildren: false,
    runningDescendantCount: 0,
    summary,
    catalogEntry: undefined,
    diagnostic: undefined,
    address: undefined,
    ordinaryOpenable: false,
    canOpen: false,
    needsRefresh: false,
    provider: undefined,
    model: undefined,
    agentPreset: undefined,
    timing: undefined,
    stats: undefined,
    tokenTotal: undefined,
    children: [],
  }
}

/**
 * The narrow inputs one root's model actually reads: the lineage closure
 * (root plus everything reachable through summary lineage and hydrated
 * catalog entries) as identity-stable summary and catalog references, plus
 * the root's upward parent chain (it decides cycle classification inside
 * the shared descendant index). Publications that leave every recorded
 * reference unchanged cannot change the model.
 */
interface LineageSelection {
  readonly childrenIndex: ReadonlyMap<SessionId, readonly SessionSummary[]>
  readonly ids: readonly SessionId[]
  readonly summaryRefs: readonly (SessionSummary | undefined)[]
  readonly catalogRefs: readonly (CatalogSnapshot | undefined)[]
  readonly rootChain: readonly (SessionSummary | undefined)[]
}

function collectLineageSelection(
  rootSessionId: SessionId,
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  catalogs: Catalogs,
): LineageSelection {
  const childrenIndex = directChildren(summaries)
  const ids: SessionId[] = [rootSessionId]
  const visited = new Set<SessionId>(ids)
  const summaryRefs: (SessionSummary | undefined)[] = []
  const catalogRefs: (CatalogSnapshot | undefined)[] = []
  const enqueue = (id: SessionId) => {
    if (visited.has(id)) return
    visited.add(id)
    ids.push(id)
  }
  // Breadth-first closure: the array grows while iterating, so every level
  // records its byId and catalog references in one deterministic order.
  for (const id of ids) {
    summaryRefs.push(summaries[id])
    catalogRefs.push(catalogs[id])
    for (const child of childrenIndex.get(id) ?? []) enqueue(child.id)
    for (const entry of catalogs[id]?.entries ?? []) enqueue(entry.id)
  }
  const rootChain: (SessionSummary | undefined)[] = []
  const seen = new Set<SessionId>()
  let current = summaries[rootSessionId]
  while (current !== undefined && current.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    current = summaries[current.parentId]
    rootChain.push(current)
  }
  return { childrenIndex, ids, summaryRefs, catalogRefs, rootChain }
}

function sameRefs<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

function sameSelection(previous: LineageSelection, next: LineageSelection): boolean {
  return sameRefs(previous.ids, next.ids)
    && sameRefs(previous.summaryRefs, next.summaryRefs)
    && sameRefs(previous.catalogRefs, next.catalogRefs)
    && sameRefs(previous.rootChain, next.rootChain)
}

function sameMembership(previous: ReadonlySet<SessionId>, next: ReadonlySet<SessionId>): boolean {
  if (previous === next) return true
  if (previous.size !== next.size) return false
  for (const id of previous) {
    if (!next.has(id)) return false
  }
  return true
}

function sameAddress(previous: SubagentAddress | undefined, next: SubagentAddress | undefined): boolean {
  if (previous === undefined || next === undefined) return previous === next
  return previous.parentSessionId === next.parentSessionId
    && previous.childSessionId === next.childSessionId
    && previous.mode === next.mode
}

/** Everything one row was derived from, kept for identity-stable reuse. */
interface RowMemo {
  readonly row: AgentFlowRow
  readonly kind: AgentFlowRow['kind']
  readonly depth: number
  readonly reason: FlowDiagnosticReason | undefined
  readonly summaryRef: SessionSummary | undefined
  readonly catalogEntryRef: ChildCatalogEntry | undefined
  readonly willExpand: boolean
  readonly openableMember: boolean
  readonly address: SubagentAddress | undefined
  readonly aggCount: number
  readonly aggRunning: number
}

const EMPTY_ROW_MEMOS: ReadonlyMap<string, RowMemo> = new Map()

interface BuildContext {
  readonly options: AgentFlowModelOptions
  readonly childrenIndex: ReadonlyMap<SessionId, readonly SessionSummary[]>
  readonly descendants: DescendantIndex
  readonly previousRows: ReadonlyMap<string, RowMemo>
  readonly nextRows: Map<string, RowMemo>
  readonly addressReads: Map<SessionId, SubagentAddress | undefined>
  /** Single mutable DFS path (add before descending, delete after) for cycle checks. */
  readonly path: Set<SessionId>
}

function childRow(source: ChildSource, parentSessionId: SessionId, depth: number, ctx: BuildContext): AgentFlowRow {
  const options = ctx.options
  const memoKey = `${parentSessionId}\u0000${source.id}`
  const memo = ctx.previousRows.get(memoKey)
  const keep = (entry: RowMemo): AgentFlowRow => {
    ctx.nextRows.set(memoKey, entry)
    return entry.row
  }
  const remember = (row: AgentFlowRow, fields: Omit<RowMemo, 'row'>): AgentFlowRow =>
    keep({ row, ...fields })
  const diagnosticMemo = (row: AgentFlowRow, reason: FlowDiagnosticReason | undefined, kind: AgentFlowRow['kind'], summaryRef: SessionSummary | undefined): AgentFlowRow =>
    remember(row, {
      kind,
      depth,
      reason,
      summaryRef,
      catalogEntryRef: undefined,
      willExpand: false,
      openableMember: false,
      address: undefined,
      aggCount: 0,
      aggRunning: 0,
    })
  const earlyReason = source.syntheticDiagnostic ?? source.diagnostic?.reason
  if (earlyReason !== undefined) {
    if (memo !== undefined && memo.kind === 'diagnostic' && memo.reason === earlyReason && memo.depth === depth) return keep(memo)
    return diagnosticMemo(diagnosticRow(parentSessionId, source.id, depth, earlyReason, source.id), earlyReason, 'diagnostic', undefined)
  }
  if (source.loading) {
    if (memo !== undefined && memo.kind === 'loading' && memo.summaryRef === source.summary && memo.depth === depth) return keep(memo)
    return diagnosticMemo(loadingRow(parentSessionId, source.id, depth, source.summary), undefined, 'loading', source.summary)
  }
  if (ctx.path.has(source.id)) {
    if (memo !== undefined && memo.kind === 'diagnostic' && memo.reason === 'cycle' && memo.depth === depth) return keep(memo)
    return diagnosticMemo(diagnosticRow(parentSessionId, source.id, depth, 'cycle', source.id), 'cycle', 'diagnostic', undefined)
  }
  const summary = source.summary ?? options.summaries[source.id]
  const aggregate = ctx.descendants.get(source.id)
  const aggCount = aggregate?.count ?? 0
  const aggRunning = aggregate?.runningCount ?? 0
  const hasChildren = source.catalogEntry?.hasChildren === true || aggCount > 0
  const willExpand = options.expanded.has(source.id) && hasChildren
  const openableMember = options.ordinaryOpenableIds.has(source.id)
  let address: SubagentAddress | undefined
  if (source.catalogEntry === undefined) {
    address = options.addressOf(source.id)
    ctx.addressReads.set(source.id, address)
  } else {
    address = {
      parentSessionId,
      childSessionId: source.id,
      mode: source.catalogEntry.mode,
    }
  }
  const reusable = memo !== undefined
    && memo.kind === 'child'
    && memo.depth === depth
    && memo.summaryRef === summary
    && memo.catalogEntryRef === source.catalogEntry
    && memo.aggCount === aggCount
    && memo.aggRunning === aggRunning
    && memo.willExpand === willExpand
    && memo.openableMember === openableMember
    && sameAddress(memo.address, address)
  let children: readonly AgentFlowRow[] = []
  if (willExpand) {
    ctx.path.add(source.id)
    children = buildRows(source.id, depth + 1, ctx)
    ctx.path.delete(source.id)
    // Reuse holds only when the whole materialized subtree held: the cached
    // children array must match the fresh walk element-wise.
    if (reusable && sameRefs(memo.row.children, children)) return keep(memo)
  } else if (reusable) {
    return keep(memo)
  }
  const identity = summary?.projectionValues?.subagent ?? null
  const mode = source.catalogEntry?.mode ?? identity?.mode
  const activity = summary === undefined
    ? source.catalogEntry?.directActivity ?? source.catalogEntry?.activity ?? 'inactive'
    : summary.running ? 'running' : 'inactive'
  const ordinaryOpenable = summary !== undefined
    && summary.origin !== 'subagent'
    && openableMember
  const runningDescendantCount = Math.max(
    aggRunning,
    source.catalogEntry?.runningDescendantCount ?? 0,
  )
  const route = summary?.projectionValues?.modelRoute
  const routePresent = route !== undefined && route !== null
  const provider = routePresent ? route.provider : undefined
  const model = routePresent ? route.model : undefined
  const agentPreset = routePresent ? undefined : summary?.agentPreset
  return remember({
    key: source.id,
    id: source.id,
    parentSessionId,
    depth,
    kind: 'child',
    label: summaryLabel(summary, source.catalogEntry?.label, source.id),
    mode,
    activity,
    hasChildren,
    runningDescendantCount,
    summary,
    catalogEntry: source.catalogEntry,
    diagnostic: undefined,
    address,
    ordinaryOpenable,
    canOpen: address !== undefined || ordinaryOpenable,
    needsRefresh: address === undefined && !ordinaryOpenable,
    provider,
    model,
    agentPreset,
    timing: summary?.projectionValues?.subagentTiming,
    stats: summary?.projectionValues?.sessionStats,
    tokenTotal: tokenTotal(summary?.projectionValues?.tokenUsage),
    children,
  }, {
    kind: 'child',
    depth,
    reason: undefined,
    summaryRef: summary,
    catalogEntryRef: source.catalogEntry,
    willExpand,
    openableMember,
    address,
    aggCount,
    aggRunning,
  })
}

function buildRows(parentSessionId: SessionId, depth: number, ctx: BuildContext): readonly AgentFlowRow[] {
  return childEntries(parentSessionId, ctx.options.catalogs, ctx.childrenIndex)
    .map(source => childRow(source, parentSessionId, depth, ctx))
}

function aggregateTokenTotal(
  rootSessionId: SessionId,
  summaryChildren: ReadonlyMap<SessionId, readonly SessionSummary[]>,
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): number | undefined {
  const visited = new Set<SessionId>()
  let total = 0
  let present = false
  const stack = [...(summaryChildren.get(rootSessionId) ?? [])]
  while (stack.length > 0) {
    const summary = stack.pop()
    if (summary === undefined || visited.has(summary.id)) continue
    visited.add(summary.id)
    const value = tokenTotal(summary.projectionValues?.tokenUsage)
    if (value !== undefined) {
      total += value
      present = true
    }
    /* v8 ignore next -- childrenIndex derives from the same summaries record, so every indexed child resolves by id */
    for (const child of summaryChildren.get(summary.id) ?? []) stack.push(summaries[child.id] ?? child)
  }
  return present ? total : undefined
}

function addressReadsValid(
  reads: ReadonlyMap<SessionId, SubagentAddress | undefined>,
  addressOf: AgentFlowModelOptions['addressOf'],
): boolean {
  for (const [id, address] of reads) {
    if (!sameAddress(addressOf(id), address)) return false
  }
  return true
}

function sameAggregate(previous: AgentFlowAggregate, next: AgentFlowAggregate): boolean {
  return previous.totalCount === next.totalCount
    && previous.runningCount === next.runningCount
    && previous.settledCount === next.settledCount
    && previous.tokenTotal === next.tokenTotal
}

interface BuilderState {
  readonly options: AgentFlowModelOptions
  readonly selection: LineageSelection
  readonly descendants: DescendantIndex
  readonly lineageTokenTotal: number | undefined
  readonly rows: ReadonlyMap<string, RowMemo>
  readonly addressReads: ReadonlyMap<SessionId, SubagentAddress | undefined>
  readonly model: AgentFlowModel
}

/** Incremental flow-model derivation retained across session-list publications. */
export interface AgentFlowModelBuilder {
  /**
   * Merge one session's retained lineage and hydrated catalogs into a lazy
   * tree, reusing every previously built row whose inputs are unchanged.
   * @param options - snapshots, expansion state, and navigation capabilities.
   * @returns stable row facts for the currently expanded levels; the previous
   * model (and its rows) keep identity while their derivation inputs hold.
   */
  build(options: AgentFlowModelOptions): AgentFlowModel
}

/**
 * Create a stateful model builder for one flow view. Session-list snapshots
 * republish wholesale per streaming batch, so the builder keys its work on
 * the narrow inputs it truly reads — the root's lineage selection — instead
 * of snapshot identity: an unchanged selection skips descendant and token
 * aggregation entirely, and unchanged subtrees keep their exact row objects.
 * @returns an independent builder; its cache never outlives its view.
 */
export function createAgentFlowModelBuilder(): AgentFlowModelBuilder {
  let state: BuilderState | undefined
  return {
    build(options) {
      const previous = state !== undefined && state.options.rootSessionId === options.rootSessionId
        ? state
        : undefined
      let selection: LineageSelection
      if (previous !== undefined
        && previous.options.summaries === options.summaries
        && previous.options.catalogs === options.catalogs) {
        selection = previous.selection
      } else {
        // One grouping pass over the summaries record is unavoidable per
        // publication; everything heavier below is gated on the outcome.
        const collected = collectLineageSelection(options.rootSessionId, options.summaries, options.catalogs)
        selection = previous !== undefined && sameSelection(previous.selection, collected)
          ? previous.selection
          : collected
      }
      const selectionHeld = previous !== undefined && selection === previous.selection
      const descendants = selectionHeld ? previous.descendants : indexSubagentDescendants(options.summaries)
      const lineageTokenTotal = selectionHeld
        ? previous.lineageTokenTotal
        : aggregateTokenTotal(options.rootSessionId, selection.childrenIndex, options.summaries)
      if (selectionHeld
        && options.addressOf === previous.options.addressOf
        && sameMembership(previous.options.expanded, options.expanded)
        && sameMembership(previous.options.ordinaryOpenableIds, options.ordinaryOpenableIds)
        && addressReadsValid(previous.addressReads, options.addressOf)) {
        state = { ...previous, options }
        return previous.model
      }
      const nextRows = new Map<string, RowMemo>()
      const addressReads = new Map<SessionId, SubagentAddress | undefined>()
      const ctx: BuildContext = {
        options,
        childrenIndex: selection.childrenIndex,
        descendants,
        previousRows: previous?.rows ?? EMPTY_ROW_MEMOS,
        nextRows,
        addressReads,
        path: new Set([options.rootSessionId]),
      }
      const rows = buildRows(options.rootSessionId, 0, ctx)
      const rootCatalog = options.catalogs[options.rootSessionId]
      const healthyCatalogCount = rootCatalog?.entries.filter(entry => entry.kind === 'child').length ?? 0
      const indexed = descendants.get(options.rootSessionId)
      const aggregate: AgentFlowAggregate = {
        totalCount: Math.max(indexed?.count ?? 0, healthyCatalogCount),
        // Existing catalog UI keeps running counts summary-backed.
        runningCount: indexed?.runningCount ?? 0,
        settledCount: Math.max(0, Math.max(indexed?.count ?? 0, healthyCatalogCount) - (indexed?.runningCount ?? 0)),
        tokenTotal: lineageTokenTotal,
      }
      const previousModel = previous?.model
      const rowsOut = previousModel !== undefined && sameRefs(previousModel.rows, rows)
        ? previousModel.rows
        : rows
      const aggregateOut = previousModel !== undefined && sameAggregate(previousModel.aggregate, aggregate)
        ? previousModel.aggregate
        : aggregate
      const model = previousModel !== undefined && rowsOut === previousModel.rows && aggregateOut === previousModel.aggregate
        ? previousModel
        : { rows: rowsOut, aggregate: aggregateOut }
      state = { options, selection, descendants, lineageTokenTotal, rows: nextRows, addressReads, model }
      return model
    },
  }
}

/**
 * Merge one session's retained lineage and hydrated catalogs into a lazy tree.
 * One-shot form of {@link createAgentFlowModelBuilder} for callers without a
 * retained builder.
 * @param options - snapshots, expansion state, and navigation capabilities.
 * @returns stable row facts for the currently expanded levels.
 */
export function buildAgentFlowModel(options: AgentFlowModelOptions): AgentFlowModel {
  return createAgentFlowModelBuilder().build(options)
}

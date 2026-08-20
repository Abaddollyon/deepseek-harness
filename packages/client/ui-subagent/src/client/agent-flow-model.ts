/** Pure merge model for the session-scoped subagent flow view. */
import { indexSubagentDescendants, type SessionId, type SessionListState, type SessionProjectionMap, type SessionSummary, type SubagentAddress, type SubagentCatalogSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { tokenTotal } from './subagent-metrics.ts'

type Catalogs = SessionListState['subagentsByParent']
type CatalogEntry = SubagentCatalogSnapshot['entries'][number]
type TimingProjection = SessionProjectionMap['subagentTiming']
type StatsProjection = SessionProjectionMap['sessionStats']

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
  readonly catalogEntry: Extract<CatalogEntry, { kind: 'child' }> | undefined
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
  readonly catalogEntry: Extract<CatalogEntry, { kind: 'child' }> | undefined
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
  const catalogIds = new Set<SessionId>()
  const sources: ChildSource[] = []
  for (const entry of catalog?.entries ?? []) {
    catalogIds.add(entry.id)
    if (entry.kind === 'diagnostic') {
      sources.push({
        id: entry.id,
        summary: undefined,
        catalogEntry: undefined,
        diagnostic: entry,
        loading: false,
      })
      continue
    }
    sources.push({
      id: entry.id,
      summary: undefined,
      catalogEntry: entry,
      diagnostic: undefined,
      loading: catalog?.state === 'loading' && catalog.entries.length === 0,
    })
  }
  const loading = catalog === undefined
    || (catalog.state === 'loading' && catalog.entries.length === 0)
    || (catalog.state === 'ready' && catalog.entries.length === 0 && summaryChildren.length > 0)
    || (catalog.state === 'error' && catalog.entries.length === 0 && summaryChildren.length > 0)
  for (const summary of summaryChildren) {
    if (catalogIds.has(summary.id)) {
      const existing = sources.find(source => source.id === summary.id)
      if (existing !== undefined) existing.summary = summary
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

function childRow(
  source: ChildSource,
  parentSessionId: SessionId,
  depth: number,
  ancestors: ReadonlySet<SessionId>,
  options: AgentFlowModelOptions,
  summaryChildren: ReadonlyMap<SessionId, readonly SessionSummary[]>,
  descendants: ReadonlyMap<SessionId, { count: number; runningCount: number }>,
): AgentFlowRow {
  if (source.syntheticDiagnostic !== undefined) {
    return diagnosticRow(parentSessionId, source.id, depth, source.syntheticDiagnostic, source.id)
  }
  if (source.diagnostic !== undefined) {
    return diagnosticRow(parentSessionId, source.id, depth, source.diagnostic.reason, source.id)
  }
  if (source.loading) return loadingRow(parentSessionId, source.id, depth, source.summary)
  if (ancestors.has(source.id)) {
    return diagnosticRow(parentSessionId, source.id, depth, 'cycle', source.id)
  }
  const summary = source.summary ?? options.summaries[source.id]
  const identity = summary?.projectionValues?.subagent ?? null
  const mode = source.catalogEntry?.mode ?? identity?.mode
  const activity = summary === undefined
    ? source.catalogEntry?.directActivity ?? source.catalogEntry?.activity ?? 'inactive'
    : summary.running ? 'running' : 'inactive'
  const address = source.catalogEntry === undefined
    ? options.addressOf(source.id)
    : {
      parentSessionId,
      childSessionId: source.id,
      mode: source.catalogEntry.mode,
    }
  const ordinaryOpenable = summary !== undefined
    && summary.origin !== 'subagent'
    && options.ordinaryOpenableIds.has(source.id)
  const aggregate = descendants.get(source.id)
  const hasChildren = source.catalogEntry?.hasChildren === true || (aggregate?.count ?? 0) > 0
  const runningDescendantCount = Math.max(
    aggregate?.runningCount ?? 0,
    source.catalogEntry?.runningDescendantCount ?? 0,
  )
  const route = summary?.projectionValues?.modelRoute
  const routePresent = route !== undefined && route !== null
  const provider = routePresent ? route.provider : undefined
  const model = routePresent ? route.model : undefined
  const agentPreset = routePresent ? undefined : summary?.agentPreset
  const children = options.expanded.has(source.id) && hasChildren
    ? buildRows(source.id, depth + 1, new Set([...ancestors, source.id]), options, summaryChildren, descendants)
    : []
  return {
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
  }
}

function buildRows(
  parentSessionId: SessionId,
  depth: number,
  ancestors: ReadonlySet<SessionId>,
  options: AgentFlowModelOptions,
  summaryChildren: ReadonlyMap<SessionId, readonly SessionSummary[]>,
  descendants: ReadonlyMap<SessionId, { count: number; runningCount: number }>,
): readonly AgentFlowRow[] {
  return childEntries(parentSessionId, options.catalogs, summaryChildren).map(source => childRow(
    source,
    parentSessionId,
    depth,
    ancestors,
    options,
    summaryChildren,
    descendants,
  ))
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
    for (const child of summaryChildren.get(summary.id) ?? []) stack.push(summaries[child.id] ?? child)
  }
  return present ? total : undefined
}

/**
 * Merge one session's retained lineage and hydrated catalogs into a lazy tree.
 * @param options - snapshots, expansion state, and navigation capabilities.
 * @returns stable row facts for the currently expanded levels.
 */
export function buildAgentFlowModel(options: AgentFlowModelOptions): AgentFlowModel {
  const summaryChildren = directChildren(options.summaries)
  const descendants = indexSubagentDescendants(options.summaries)
  const rows = buildRows(
    options.rootSessionId,
    0,
    new Set([options.rootSessionId]),
    options,
    summaryChildren,
    descendants,
  )
  const rootCatalog = options.catalogs[options.rootSessionId]
  const healthyCatalogCount = rootCatalog?.entries.filter(entry => entry.kind === 'child').length ?? 0
  const indexed = descendants.get(options.rootSessionId)
  return {
    rows,
    aggregate: {
      totalCount: Math.max(indexed?.count ?? 0, healthyCatalogCount),
      // Existing catalog UI keeps running counts summary-backed.
      runningCount: indexed?.runningCount ?? 0,
      settledCount: Math.max(0, Math.max(indexed?.count ?? 0, healthyCatalogCount) - (indexed?.runningCount ?? 0)),
      tokenTotal: aggregateTokenTotal(options.rootSessionId, summaryChildren, options.summaries),
    },
  }
}

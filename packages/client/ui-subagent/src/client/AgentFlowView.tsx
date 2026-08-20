import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconRefreshOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { activityDuration, formatDuration, formatExactDuration, formatTokens } from './subagent-metrics.ts'
import { buildAgentFlowModel, type AgentFlowModel, type AgentFlowRow, type FlowDiagnosticReason } from './agent-flow-model.ts'
import { NS } from './locales.ts'
import css from './AgentFlowView.module.css'

/** Navigation and lazy-catalog callbacks supplied by the plugin apply closure. */
export interface AgentFlowInjected {
  openChild: (address: SubagentAddress) => void
  openSession: (id: SessionId) => void
  addressOf: (id: SessionId) => SubagentAddress | undefined
  refresh: (parentSessionId: SessionId) => void
  setCatalogOpen: (parentSessionId: SessionId, open: boolean) => void
}

/** Props for the session-scoped agent flow view. */
export type AgentFlowViewProps =
  PropsRuntime<'conversation.view'> & AgentFlowInjected & PropsLocale<typeof NS>

interface FlowRowProps {
  row: AgentFlowRow
  expanded: boolean
  expandedSet: ReadonlySet<SessionId>
  now: number
  t: TranslateNS<typeof NS>
  onOpen: (row: AgentFlowRow) => void
  onRefresh: (row: AgentFlowRow) => void
  onToggle: (row: AgentFlowRow) => void
}

interface FlowRowsProps extends Omit<FlowRowProps, 'row' | 'expanded'> {
  rows: readonly AgentFlowRow[]
  expanded: ReadonlySet<SessionId>
}

function diagnosticText(reason: FlowDiagnosticReason | undefined, t: TranslateNS<typeof NS>): string {
  switch (reason) {
    case 'corrupt': return t('diagnostic.corrupt')
    case 'unsupported': return t('diagnostic.unsupported')
    case 'unavailable': return t('diagnostic.unavailable')
    case 'cycle': return t('diagnostic.cycle')
    case 'load-error': return t('load.error')
    default: return t('diagnostic.unavailable')
  }
}

function identityText(row: AgentFlowRow, t: TranslateNS<typeof NS>): string {
  if (row.provider !== undefined || row.model !== undefined) {
    return (row.provider ?? t('identity.unavailablePart')) + ' / ' + (row.model ?? t('identity.unavailablePart'))
  }
  if (row.agentPreset !== undefined && row.agentPreset.length > 0) {
    return t('identity.preset', { preset: row.agentPreset })
  }
  return t('identity.unavailable')
}

function rowDuration(row: AgentFlowRow, now: number, t: TranslateNS<typeof NS>): { compact: string; exact: string } | undefined {
  if (row.summary === undefined || row.timing === undefined) return undefined
  const duration = activityDuration(row.summary, row.activity, now)
  if (duration === undefined) return undefined
  return {
    compact: formatDuration(duration, t),
    exact: formatExactDuration(duration, t),
  }
}

function flowRowAria(row: AgentFlowRow, now: number, t: TranslateNS<typeof NS>): string {
  if (row.kind !== 'child') {
    return t('row.diagnosticAria', {
      label: row.label,
      reason: row.kind === 'loading' ? t('loading.aria') : diagnosticText(row.diagnostic, t),
      depth: row.depth,
    })
  }
  const duration = rowDuration(row, now, t)
  return t('row.aria', {
    label: row.label,
    state: row.activity === 'running' ? t('activity.running') : t('activity.settled'),
    identity: identityText(row, t),
    tokens: row.tokenTotal === undefined ? '—' : formatTokens(row.tokenTotal),
    duration: duration?.exact ?? '—',
    depth: row.depth,
  })
}

function onRowKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  row: AgentFlowRow,
  expanded: boolean,
  onOpen: (row: AgentFlowRow) => void,
  onToggle: (row: AgentFlowRow) => void,
) {
  switch (event.key) {
    case 'Enter':
    case ' ': {
      if (row.canOpen) {
        event.preventDefault()
        onOpen(row)
      }
      break
    }
    case 'ArrowRight':
      if (row.hasChildren && !expanded) {
        event.preventDefault()
        onToggle(row)
      }
      break
    case 'ArrowLeft':
      if (row.hasChildren && expanded) {
        event.preventDefault()
        onToggle(row)
      }
      break
  }
}

const FlowRow = memo(function FlowRow({ row, expanded, expandedSet, now, t, onOpen, onRefresh, onToggle }: FlowRowProps) {
  if (row.kind !== 'child') {
    const loading = row.kind === 'loading'
    return (
      <div className={css.node}>
        <div
          role="treeitem"
          aria-disabled="true"
          aria-level={row.depth + 1}
          aria-label={flowRowAria(row, now, t)}
          data-flow-id={row.key}
          data-flow-depth={row.depth}
          className={[css.row, css.disabled, loading ? css.loadingRow : css.diagnosticRow].join(' ')}
        >
          <span className={css.disclosureSpace} />
          <StateDot state={loading ? (row.activity === 'running' ? 'ongoing' : 'done') : 'error'} />
          <span className={css.content}>
            <span className={css.label}>{loading && row.summary === undefined ? t('loading.label') : row.label}</span>
            <span className={css.summary}>{loading ? t('loading.aria') : diagnosticText(row.diagnostic, t)}</span>
          </span>
          {row.diagnostic === 'load-error' && (
            <button
              type="button"
              className={css.retry}
              aria-label={t('retry')}
              onClick={() => { onRefresh(row) }}
            >
              <IconRefreshOutline14 />
              <span className={css.srOnly}>{t('retry')}</span>
            </button>
          )}
        </div>
      </div>
    )
  }
  const duration = rowDuration(row, now, t)
  const identity = identityText(row, t)
  const tokenText = row.tokenTotal === undefined ? '—' : formatTokens(row.tokenTotal)
  const metadata = [
    row.mode === 'one-shot' ? t('mode.oneShot') : row.mode === 'continuable' ? t('mode.continuable') : undefined,
    row.activity === 'running' ? t('activity.running') : t('activity.settled'),
  ].filter((value): value is string => value !== undefined).join(' · ')
  return (
    <div className={css.node}>
      <div
        role="treeitem"
        aria-disabled={row.canOpen ? undefined : 'true'}
        aria-level={row.depth + 1}
        aria-expanded={row.hasChildren ? expanded : undefined}
        aria-label={flowRowAria(row, now, t)}
        data-flow-id={row.key}
        data-flow-depth={row.depth}
        tabIndex={row.canOpen || row.hasChildren ? 0 : -1}
        className={[css.row, row.canOpen ? css.openable : css.disabled].join(' ')}
        title={duration === undefined ? undefined : t('duration.exactTitle', { duration: duration.exact })}
        onClick={() => { if (row.canOpen) onOpen(row) }}
        onKeyDown={(event) => { onRowKeyDown(event, row, expanded, onOpen, onToggle) }}
      >
        {row.hasChildren ? (
          <button
            type="button"
            className={css.disclosure}
            aria-label={expanded ? t('branch.collapse', { label: row.label }) : t('branch.expand', { label: row.label })}
            aria-expanded={expanded}
            onClick={(event) => { event.stopPropagation(); onToggle(row) }}
          >
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </button>
        ) : <span className={css.disclosureSpace} />}
        <StateDot state={row.activity === 'running' ? 'ongoing' : 'done'} />
        <span className={css.content}>
          <span className={css.label}>{row.label}</span>
          <span className={css.summary}>{metadata}</span>
        </span>
        <span className={css.identity}>{identity}</span>
        <span className={css.metric}>{t('metric.tokens', { tokens: tokenText })}</span>
        <span className={css.metric}>{t('metric.duration', { duration: duration?.compact ?? '—' })}</span>
        <span className={css.metric}>{t('metric.depth', { depth: row.depth })}</span>
        {row.stats !== undefined && (
          <span className={css.metric}>{t('metric.turnsSteps', { turns: row.stats.turns, steps: row.stats.steps })}</span>
        )}
        {!row.canOpen && row.needsRefresh && (
          <button
            type="button"
            className={css.retry}
            aria-label={t('row.refresh', { label: row.label })}
            onClick={(event) => { event.stopPropagation(); onRefresh(row) }}
          >
            <IconRefreshOutline14 />
          </button>
        )}
      </div>
      {expanded && row.children.length > 0 && (
        <div role="group" id={'flow-group-' + row.key} className={css.children}>
          <FlowRows
            rows={row.children}
            expanded={expandedSet}
            expandedSet={expandedSet}
            now={now}
            t={t}
            onOpen={onOpen}
            onRefresh={onRefresh}
            onToggle={onToggle}
          />
        </div>
      )}
    </div>
  )
})

function FlowRows({ rows, expanded, now, t, onOpen, onRefresh, onToggle }: FlowRowsProps) {
  return rows.map((row) => {
    const rowNow = row.kind === 'child' && row.activity === 'running' && row.timing?.active !== undefined ? now : 0
    return (
      <FlowRow
        key={row.key}
        row={row}
        expanded={expanded.has(row.id)}
        expandedSet={expanded}
        now={rowNow}
        t={t}
        onOpen={onOpen}
        onRefresh={onRefresh}
        onToggle={onToggle}
      />
    )
  })
}

function hasActiveTiming(rows: readonly AgentFlowRow[]): boolean {
  for (const row of rows) {
    if (row.kind === 'child' && row.activity === 'running' && row.timing?.active !== undefined) return true
    if (hasActiveTiming(row.children)) return true
  }
  return false
}

function treeItems(root: HTMLDivElement | null): HTMLElement[] {
  return root === null
    ? []
    : Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])'))
}

function focusTreeItem(root: HTMLDivElement | null, offset: number) {
  const items = treeItems(root)
  const active = document.activeElement
  const index = items.indexOf(active as HTMLElement)
  if (items.length === 0) return
  const next = index < 0 ? 0 : (index + offset + items.length) % items.length
  items[next]?.focus()
}

function collectObservedDescendant(id: SessionId, candidate: SessionId, parents: ReadonlyMap<SessionId, SessionId | undefined>): boolean {
  let current: SessionId | undefined = candidate
  while (current !== undefined) {
    if (current === id) return true
    current = parents.get(current)
  }
  return false
}

/**
 * Render the lazy, session-scoped subagent lineage view.
 * @param props - framework session props, locale, and navigation callbacks.
 * @returns the flow frame.
 */
export function AgentFlowView({
  sessionId,
  useSessions,
  t,
  openChild,
  openSession,
  addressOf,
  refresh,
  setCatalogOpen,
}: AgentFlowViewProps) {
  const summaries = useSessions(state => state.byId)
  const catalogs = useSessions(state => state.subagentsByParent)
  const ids = useSessions(state => state.ids)
  const [expanded, setExpanded] = useState<ReadonlySet<SessionId>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  const observed = useRef(new Set<SessionId>())
  const observedParents = useRef(new Map<SessionId, SessionId | undefined>())
  const latestSetCatalogOpen = useRef(setCatalogOpen)
  latestSetCatalogOpen.current = setCatalogOpen
  const ordinaryOpenableIds = useMemo(() => new Set(ids), [ids])
  const model = useMemo<AgentFlowModel>(() => buildAgentFlowModel({
    rootSessionId: sessionId,
    summaries,
    catalogs,
    expanded,
    ordinaryOpenableIds,
    addressOf,
  }), [addressOf, catalogs, expanded, ordinaryOpenableIds, sessionId, summaries])
  const activeTiming = useMemo(() => hasActiveTiming(model.rows), [model.rows])
  const treeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const oldObserved = observed.current
    for (const parentId of oldObserved) latestSetCatalogOpen.current(parentId, false)
    oldObserved.clear()
    observedParents.current.clear()
    setExpanded(new Set())
    latestSetCatalogOpen.current(sessionId, true)
    oldObserved.add(sessionId)
    observedParents.current.set(sessionId, undefined)
    return () => {
      for (const parentId of observed.current) latestSetCatalogOpen.current(parentId, false)
      observed.current.clear()
      observedParents.current.clear()
    }
  }, [sessionId])

  useEffect(() => {
    if (!activeTiming) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [activeTiming])

  const onToggle = useCallback((row: AgentFlowRow) => {
    if (!row.hasChildren) return
    if (expanded.has(row.id)) {
      const closeIds = new Set<SessionId>()
      for (const parentId of observed.current) {
        if (collectObservedDescendant(row.id, parentId, observedParents.current)) closeIds.add(parentId)
      }
      for (const parentId of closeIds) {
        latestSetCatalogOpen.current(parentId, false)
        observed.current.delete(parentId)
        observedParents.current.delete(parentId)
      }
      setExpanded((previous) => {
        const next = new Set(previous)
        next.delete(row.id)
        for (const parentId of closeIds) next.delete(parentId)
        return next
      })
      return
    }
    latestSetCatalogOpen.current(row.id, true)
    observed.current.add(row.id)
    observedParents.current.set(row.id, row.parentSessionId)
    setExpanded(previous => new Set(previous).add(row.id))
  }, [expanded])

  const onOpen = useCallback((row: AgentFlowRow) => {
    if (row.address !== undefined) {
      openChild(row.address)
    } else if (row.ordinaryOpenable) {
      openSession(row.id)
    }
  }, [openChild, openSession])

  const onRefresh = useCallback((row: AgentFlowRow) => {
    refresh(row.parentSessionId)
  }, [refresh])

  const onTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusTreeItem(treeRef.current, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusTreeItem(treeRef.current, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      const items = treeItems(treeRef.current)
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      const items = treeItems(treeRef.current)
      items.at(-1)?.focus()
    }
  }, [])

  const totalKey = model.aggregate.totalCount === 1 ? 'count.total.one' : 'count.total.other'
  const runningKey = model.aggregate.runningCount === 1 ? 'count.running.one' : 'count.running.other'
  return (
    <section className={css.root} aria-labelledby={'agent-flow-title-' + sessionId}>
      <header className={css.header}>
        <div>
          <h2 id={'agent-flow-title-' + sessionId} className={css.title}>{t('flow.title')}</h2>
          <p className={css.summary}>{t('flow.summary', { total: model.aggregate.totalCount, running: model.aggregate.runningCount, settled: model.aggregate.settledCount })}</p>
        </div>
        <div className={css.headerMetrics}>
          <span>{t(totalKey, { count: model.aggregate.totalCount })}</span>
          <span>{t(runningKey, { count: model.aggregate.runningCount })}</span>
          {model.aggregate.tokenTotal !== undefined && <span>{t('metric.tokens', { tokens: formatTokens(model.aggregate.tokenTotal) })}</span>}
        </div>
      </header>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t('tree.aria')}
        className={css.tree}
        onKeyDown={onTreeKeyDown}
      >
        {model.rows.length === 0 ? (
          <p className={css.empty}>{t('flow.empty')}</p>
        ) : (
          <FlowRows
            rows={model.rows}
            expanded={expanded}
            expandedSet={expanded}
            now={now}
            t={t}
            onOpen={onOpen}
            onRefresh={onRefresh}
            onToggle={onToggle}
          />
        )}
      </div>
    </section>
  )
}

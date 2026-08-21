/**
 * Incremental agent-flow model derivation: narrow-input memoization, row
 * identity reuse, aggregate deltas, and collapsed-subtree laziness. Rendered
 * behavior stays covered by agent-flow.client.spec.tsx; this suite pins the
 * builder's operation counts and identity guarantees.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import {
  buildAgentFlowModel, createAgentFlowModelBuilder,
  type AgentFlowModel, type AgentFlowModelOptions, type AgentFlowRow,
} from '../src/client/agent-flow-model.ts'

type Catalog = SessionListState['subagentsByParent'][SessionId]
type CatalogEntry = Catalog['entries'][number]
const sid = (value: string) => value as SessionId
const ROOT = sid('root')

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

function catalog(entries: readonly CatalogEntry[], state: 'loading' | 'ready' | 'error' = 'ready'): Catalog {
  return { entries: [...entries], parentAvailable: true, state, error: null } as unknown as Catalog
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
  } as CatalogEntry
}

function diagnostic(id: string, reason: 'corrupt' | 'unsupported' | 'unavailable'): CatalogEntry {
  return { kind: 'diagnostic', id: sid(id), reason } as CatalogEntry
}

/** Shared default so equal option sets keep one addressOf identity. */
const NO_ADDRESS: AgentFlowModelOptions['addressOf'] = () => undefined

function opts(partial: Partial<AgentFlowModelOptions>): AgentFlowModelOptions {
  return {
    rootSessionId: ROOT,
    summaries: {},
    catalogs: {},
    expanded: new Set<SessionId>(),
    ordinaryOpenableIds: new Set<SessionId>(),
    addressOf: NO_ADDRESS,
    ...partial,
  }
}

function collectRows(rows: readonly AgentFlowRow[], into: AgentFlowRow[] = []): AgentFlowRow[] {
  for (const row of rows) {
    into.push(row)
    collectRows(row.children, into)
  }
  return into
}

/** Count row objects in \`next\` absent from \`previous\` — constructions, not reuses. */
function newRowCount(previous: AgentFlowModel, next: AgentFlowModel): number {
  const seen = new Set(collectRows(previous.rows))
  return collectRows(next.rows).filter(row => !seen.has(row)).length
}

function tokens(total: number): Record<string, unknown> {
  return { tokenUsage: { uncachedInputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

describe('wide fan-out', () => {
  const width = 500
  function fanOut(): { summaries: Record<SessionId, SessionSummary>; catalogs: Record<SessionId, Catalog> } {
    const summaries: Record<SessionId, SessionSummary> = {}
    const entries: CatalogEntry[] = []
    for (let index = 0; index < width; index += 1) {
      const id = 'child-' + index
      summaries[sid(id)] = summary(id, 'root', { running: true, projectionValues: tokens(10) })
      entries.push(child(id))
    }
    return { summaries, catalogs: { [ROOT]: catalog(entries) } }
  }

  it('returns the identical model for a publication outside the lineage', () => {
    const { summaries, catalogs } = fanOut()
    const builder = createAgentFlowModelBuilder()
    const base = opts({ summaries, catalogs })
    const first = builder.build(base)
    expect(first.rows).toHaveLength(width)
    const second = builder.build(opts({
      ...base,
      summaries: { ...summaries, [sid('elsewhere')]: summary('elsewhere', 'other-root', { running: true }) },
    }))
    expect(second).toBe(first)
  })

  it('constructs exactly one row for a single leaf delta across 500 children', () => {
    const { summaries, catalogs } = fanOut()
    const builder = createAgentFlowModelBuilder()
    const base = opts({ summaries, catalogs })
    const first = builder.build(base)
    const next = opts({
      ...base,
      summaries: { ...summaries, [sid('child-42')]: summary('child-42', 'root', { running: false, projectionValues: tokens(999) }) },
    })
    const second = builder.build(next)
    expect(second).not.toBe(first)
    expect(newRowCount(first, second)).toBe(1)
    expect(second.rows[42]).not.toBe(first.rows[42])
    expect(second.rows[0]).toBe(first.rows[0])
    expect(second.rows[499]).toBe(first.rows[499])
    // Aggregates follow the delta and the output matches a from-scratch build.
    expect(second.aggregate.runningCount).toBe(width - 1)
    expect(second.aggregate.tokenTotal).toBe((width - 1) * 10 + 999)
    expect(second).toEqual(buildAgentFlowModel(next))
  })
})

describe('deep chain deltas', () => {
  function chain(dExtra: Record<string, unknown>): { summaries: Record<SessionId, SessionSummary>; catalogs: Record<SessionId, Catalog> } {
    return {
      summaries: {
        [sid('a')]: summary('a', 'root'),
        [sid('s')]: summary('s', 'a', { projectionValues: tokens(5) }),
        [sid('b')]: summary('b', 'a'),
        [sid('c')]: summary('c', 'b'),
        [sid('d')]: summary('d', 'c', dExtra),
        [sid('e')]: summary('e', 'root'),
        [sid('f')]: summary('f', 'e'),
      },
      catalogs: {
        [ROOT]: catalog([child('a', 'continuable', { hasChildren: true }), child('e', 'continuable', { hasChildren: true })]),
        [sid('a')]: catalog([child('b', 'continuable', { hasChildren: true }), child('s')]),
        [sid('b')]: catalog([child('c', 'continuable', { hasChildren: true })]),
        [sid('c')]: catalog([child('d')]),
        [sid('e')]: catalog([child('f')]),
      },
    }
  }

  it('rebuilds only the ancestor path for a leaf running/token delta and updates aggregates', () => {
    const before = chain({ running: false, projectionValues: tokens(10) })
    const expanded = new Set([sid('a'), sid('b'), sid('c'), sid('e')])
    const builder = createAgentFlowModelBuilder()
    const base = opts({ summaries: before.summaries, catalogs: before.catalogs, expanded })
    const first = builder.build(base)
    expect(first.aggregate.runningCount).toBe(0)
    expect(first.aggregate.tokenTotal).toBe(15)
    // Only the leaf summary reference changes, exactly like a streaming batch.
    const next = opts({
      ...base,
      summaries: { ...before.summaries, [sid('d')]: summary('d', 'c', { running: true, projectionValues: tokens(20) }) },
    })
    const second = builder.build(next)
    // a, b, c carry a changed running-descendant count; d changed itself.
    expect(newRowCount(first, second)).toBe(4)
    const rowOf = (model: AgentFlowModel, id: string) => collectRows(model.rows).find(row => row.id === sid(id))
    expect(rowOf(second, 's')).toBe(rowOf(first, 's'))
    // The expanded sibling branch is reused wholesale, subtree included.
    expect(rowOf(second, 'e')).toBe(rowOf(first, 'e'))
    expect(rowOf(second, 'f')).toBe(rowOf(first, 'f'))
    expect(second.aggregate.runningCount).toBe(1)
    expect(second.aggregate.tokenTotal).toBe(25)
    expect(second).toEqual(buildAgentFlowModel(next))
  })

  it('keeps the aggregate object identity when only presentation facts change', () => {
    const before = chain({ projectionValues: tokens(10) })
    const expanded = new Set([sid('a'), sid('b'), sid('c'), sid('e')])
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ summaries: before.summaries, catalogs: before.catalogs, expanded }))
    const second = builder.build(opts({
      summaries: { ...before.summaries, [sid('d')]: summary('d', 'c', { title: 'renamed', projectionValues: tokens(10) }) },
      catalogs: before.catalogs,
      expanded,
    }))
    expect(second).not.toBe(first)
    expect(second.aggregate).toBe(first.aggregate)
    expect(collectRows(second.rows).find(row => row.id === sid('d'))?.label).toBe('renamed')
  })
})

describe('collapsed subtrees', () => {
  const summaries = {
    [sid('a')]: summary('a', 'root'),
    [sid('a1')]: summary('a1', 'a', { projectionValues: tokens(7) }),
    [sid('a2')]: summary('a2', 'a1', { running: true }),
  }
  const catalogs = {
    [ROOT]: catalog([child('a', 'continuable', { hasChildren: true })]),
    [sid('a')]: catalog([child('a1', 'continuable', { hasChildren: true })]),
    [sid('a1')]: catalog([child('a2')]),
  }

  it('contributes aggregates without materializing collapsed rows', () => {
    const builder = createAgentFlowModelBuilder()
    const collapsed = builder.build(opts({ summaries, catalogs }))
    expect(collectRows(collapsed.rows)).toHaveLength(1)
    expect(collapsed.aggregate.totalCount).toBe(3)
    expect(collapsed.aggregate.runningCount).toBe(1)
    expect(collapsed.aggregate.tokenTotal).toBe(7)
    const expanded = builder.build(opts({ summaries, catalogs, expanded: new Set([sid('a'), sid('a1')]) }))
    expect(collectRows(expanded.rows)).toHaveLength(3)
    const recollapsed = builder.build(opts({ summaries, catalogs }))
    expect(collectRows(recollapsed.rows)).toHaveLength(1)
    expect(recollapsed.rows[0]?.children).toHaveLength(0)
  })

  it('updates the model for a delta inside a collapsed subtree while reusing every row', () => {
    const builder = createAgentFlowModelBuilder()
    const base = opts({ summaries, catalogs })
    const first = builder.build(base)
    const second = builder.build(opts({
      ...base,
      summaries: { ...summaries, [sid('a2')]: summary('a2', 'a1', { running: true, projectionValues: tokens(100) }) },
    }))
    expect(second).not.toBe(first)
    // The single visible row keeps identity: nothing it renders changed.
    expect(second.rows).toBe(first.rows)
    expect(second.aggregate.tokenTotal).toBe(107)
  })
})

describe('fast-path validation', () => {
  const summaries = { [sid('a')]: summary('a', 'root') }
  const catalogs = { [ROOT]: catalog([child('a')]) }

  it('holds across equal-content expanded and openable set rebuilds, and resets per root', () => {
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({
      summaries, catalogs, expanded: new Set([sid('x')]), ordinaryOpenableIds: new Set([ROOT]),
    }))
    const second = builder.build(opts({
      summaries, catalogs, expanded: new Set([sid('x')]), ordinaryOpenableIds: new Set([ROOT]),
    }))
    expect(second).toBe(first)
    const otherRoot = builder.build(opts({ rootSessionId: sid('a'), summaries, catalogs: {} }))
    expect(otherRoot).not.toBe(first)
    expect(otherRoot.rows).toHaveLength(0)
  })

  it('rebuilds on expanded membership changes of equal size', () => {
    const wide = {
      summaries: { [sid('a')]: summary('a', 'root'), [sid('a1')]: summary('a1', 'a') },
      catalogs: { [ROOT]: catalog([child('a', 'continuable', { hasChildren: true })]), [sid('a')]: catalog([child('a1')]) },
    }
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ ...wide, expanded: new Set([sid('a')]) }))
    expect(collectRows(first.rows)).toHaveLength(2)
    const second = builder.build(opts({ ...wide, expanded: new Set([sid('other')]) }))
    expect(collectRows(second.rows)).toHaveLength(1)
  })

  it('rebuilds when openable membership shrinks and flips ordinary openability', () => {
    const forkState = {
      summaries: { [sid('fork')]: summary('fork', undefined, { origin: 'user' }) },
      catalogs: { [ROOT]: catalog([child('fork')]) },
    }
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ ...forkState, ordinaryOpenableIds: new Set([sid('fork')]) }))
    expect(first.rows[0]?.ordinaryOpenable).toBe(true)
    const second = builder.build(opts({ ...forkState, ordinaryOpenableIds: new Set() }))
    expect(second.rows[0]?.ordinaryOpenable).toBe(false)
  })

  it('rebuilds when the addressOf function identity changes', () => {
    const builder = createAgentFlowModelBuilder()
    const base = opts({ summaries, catalogs })
    const first = builder.build(base)
    const second = builder.build(opts({ ...base, addressOf: () => undefined }))
    expect(second).toEqual(first)
  })

  it('re-derives when a retained address appears, changes fields, or disappears', () => {
    // A summary-only child (no catalog entry) reads addressOf each build.
    // The root catalog stays non-empty so the child is not a loading row.
    const lone = {
      summaries: { [sid('a')]: summary('a', 'root') },
      catalogs: { [ROOT]: catalog([child('listed')]) },
    }
    const addr = (mode: 'one-shot' | 'continuable', childId = 'a', parentId = 'root'): SubagentAddress =>
      ({ parentSessionId: sid(parentId), childSessionId: sid(childId), mode }) as SubagentAddress
    let current: SubagentAddress | undefined
    const addressOf = () => current
    const builder = createAgentFlowModelBuilder()
    const base = opts({ ...lone, addressOf })
    const aRow = (model: AgentFlowModel) => model.rows.find(row => row.id === sid('a'))
    expect(aRow(builder.build(base))?.canOpen).toBe(false)
    current = addr('one-shot')
    const appeared = builder.build(base)
    expect(aRow(appeared)?.canOpen).toBe(true)
    expect(aRow(appeared)?.address).toEqual(addr('one-shot'))
    // Unchanged reads validate and the fast path returns the same model.
    expect(builder.build(base)).toBe(appeared)
    current = addr('continuable')
    expect(aRow(builder.build(base))?.address).toEqual(addr('continuable'))
    current = addr('continuable', 'other')
    expect(aRow(builder.build(base))?.address).toEqual(addr('continuable', 'other'))
    current = addr('continuable', 'other', 'other-parent')
    expect(aRow(builder.build(base))?.address).toEqual(addr('continuable', 'other', 'other-parent'))
    current = undefined
    expect(aRow(builder.build(base))?.canOpen).toBe(false)
  })

  it('reuses rows through a same-content catalog snapshot replacement', () => {
    const entries = [child('a')]
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ summaries, catalogs: { [ROOT]: catalog(entries) } }))
    const second = builder.build(opts({ summaries, catalogs: { [ROOT]: { ...catalog([]), entries } as Catalog } }))
    expect(second).toBe(first)
  })
})

describe('row memo transitions', () => {
  it('reuses diagnostic rows and rebuilds on a reason change', () => {
    const builder = createAgentFlowModelBuilder()
    // The healthy entry object is shared: the ledger replaces snapshots, not
    // untouched entries, and row reuse rides entry identity.
    const aEntry = child('a')
    const base = opts({ catalogs: { [ROOT]: catalog([diagnostic('x', 'corrupt'), aEntry]) } })
    const first = builder.build(base)
    const second = builder.build(opts({
      ...base,
      summaries: { [sid('other')]: summary('other', 'elsewhere') },
      catalogs: { [ROOT]: catalog([diagnostic('x', 'corrupt'), aEntry]) },
    }))
    expect(second.rows[0]).toBe(first.rows[0])
    const third = builder.build(opts({
      ...base,
      catalogs: { [ROOT]: catalog([diagnostic('x', 'unavailable'), aEntry]) },
    }))
    expect(third.rows[0]).not.toBe(second.rows[0])
    expect(third.rows[0]?.diagnostic).toBe('unavailable')
    expect(third.rows[1]).toBe(second.rows[1])
  })

  it('reuses loading rows, rebuilds them on summary deltas, and hydrates to child rows', () => {
    const pending = { [sid('p')]: summary('p', 'root') }
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ summaries: pending }))
    expect(first.rows[0]?.kind).toBe('loading')
    const second = builder.build(opts({ summaries: { ...pending, [sid('noise')]: summary('noise', 'elsewhere') } }))
    expect(second.rows[0]).toBe(first.rows[0])
    // An inert expanded change forces a walk that reuses the loading row.
    const walked = builder.build(opts({ summaries: pending, expanded: new Set([sid('inert')]) }))
    expect(walked.rows[0]).toBe(first.rows[0])
    const third = builder.build(opts({ summaries: { [sid('p')]: summary('p', 'root', { running: true }) } }))
    expect(third.rows[0]).not.toBe(first.rows[0])
    expect(third.rows[0]?.kind).toBe('loading')
    const hydrated = builder.build(opts({
      summaries: { [sid('p')]: summary('p', 'root', { running: true }) },
      catalogs: { [ROOT]: catalog([child('p')]) },
    }))
    expect(hydrated.rows[0]?.kind).toBe('child')
  })

  it('rebuilds a row whose kind flips between child and diagnostic', () => {
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ catalogs: { [ROOT]: catalog([child('x')]) } }))
    expect(first.rows[0]?.kind).toBe('child')
    const second = builder.build(opts({ catalogs: { [ROOT]: catalog([diagnostic('x', 'corrupt')]) } }))
    expect(second.rows[0]?.kind).toBe('diagnostic')
    const third = builder.build(opts({ catalogs: { [ROOT]: catalog([child('x')]) } }))
    expect(third.rows[0]?.kind).toBe('child')
  })

  it('reuses cycle diagnostics and load-error rows across unrelated churn', () => {
    const cycleState = {
      summaries: { [sid('a')]: summary('a', 'root') },
      catalogs: {
        [ROOT]: catalog([child('a', 'continuable', { hasChildren: true })]),
        [sid('a')]: catalog([child('root')], 'error'),
      },
    }
    const expanded = new Set([sid('a')])
    const builder = createAgentFlowModelBuilder()
    const base = opts({ ...cycleState, expanded })
    const first = builder.build(base)
    const nested = first.rows[0]?.children ?? []
    expect(nested.map(row => row.diagnostic)).toEqual(['cycle', 'load-error'])
    const second = builder.build(opts({
      ...base,
      summaries: { ...cycleState.summaries, [sid('noise')]: summary('noise', 'elsewhere') },
    }))
    expect(second.rows[0]).toBe(first.rows[0])
    // An inert expanded-membership change forces a walk: the cycle and
    // load-error rows are reused, so the expanded parent row is too.
    const third = builder.build(opts({ ...base, expanded: new Set([sid('a'), sid('inert')]) }))
    expect(third.rows[0]).toBe(first.rows[0])
  })

  it('rebuilds re-keyed and deepened rows when the tree above them moves', () => {
    // P1 carries a child + diagnostic + cycle-source catalog; P2 carries a
    // summary-only loading child. Inserting level N deepens all their rows.
    const xSummary = summary('x', 'p1')
    const lpSummary = summary('lp', 'p2')
    const level = (deep: boolean) => {
      const parentOfP = deep ? 'n' : 'root'
      const summaries: Record<SessionId, SessionSummary> = {
        [sid('p1')]: summary('p1', parentOfP),
        [sid('p2')]: summary('p2', parentOfP),
        [sid('x')]: xSummary,
        [sid('lp')]: lpSummary,
      }
      if (deep) summaries[sid('n')] = summary('n', 'root')
      const catalogs: Record<SessionId, Catalog> = {
        [ROOT]: deep
          ? catalog([child('n', 'continuable', { hasChildren: true })])
          : catalog([child('p1', 'continuable', { hasChildren: true }), child('p2', 'continuable', { hasChildren: true })]),
        [sid('p1')]: catalog([child('x'), diagnostic('broken', 'corrupt'), child('root')]),
      }
      if (deep) catalogs[sid('n')] = catalog([child('p1', 'continuable', { hasChildren: true }), child('p2', 'continuable', { hasChildren: true })])
      return { summaries, catalogs }
    }
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ ...level(false), expanded: new Set([sid('p1'), sid('p2')]) }))
    const rowsBefore = collectRows(first.rows)
    const second = builder.build(opts({ ...level(true), expanded: new Set([sid('n'), sid('p1'), sid('p2')]) }))
    const rowsAfter = collectRows(second.rows)
    // Every previously visible row deepened by one level, so none is reused.
    expect(newRowCount(first, second)).toBe(rowsAfter.length)
    const depthOf = (rows: AgentFlowRow[], id: string) => rows.find(row => row.id === sid(id) && row.kind !== 'diagnostic')?.depth
    expect(depthOf(rowsBefore, 'x')).toBe(1)
    expect(depthOf(rowsAfter, 'x')).toBe(2)
    expect(rowsAfter.find(row => row.diagnostic === 'cycle')?.depth).toBe(2)
    expect(rowsAfter.find(row => row.diagnostic === 'corrupt')?.depth).toBe(2)
    expect(rowsAfter.find(row => row.kind === 'loading')?.depth).toBe(2)
  })

  it('merges the summary into the first of duplicate catalog entries', () => {
    const model = buildAgentFlowModel(opts({
      summaries: { [sid('dup')]: summary('dup', 'root', { running: true }) },
      catalogs: { [ROOT]: catalog([child('dup'), child('dup')]) },
    }))
    expect(model.rows).toHaveLength(2)
    expect(model.rows[0]?.activity).toBe('running')
    expect(model.rows[1]?.activity).toBe('running')
  })

  it('rebuilds a collapsed row when descendants appear under it', () => {
    const builder = createAgentFlowModelBuilder()
    const base = {
      summaries: { [sid('a')]: summary('a', 'root') },
      catalogs: { [ROOT]: catalog([child('a')]) },
    }
    const first = builder.build(opts(base))
    expect(first.rows[0]?.hasChildren).toBe(false)
    const second = builder.build(opts({
      ...base,
      summaries: { ...base.summaries, [sid('a1')]: summary('a1', 'a') },
    }))
    expect(second.rows[0]).not.toBe(first.rows[0])
    expect(second.rows[0]?.hasChildren).toBe(true)
  })
})

describe('catalog states and labels', () => {
  it('keeps catalog and summary children as child rows during a nonempty loading snapshot', () => {
    const model = buildAgentFlowModel(opts({
      summaries: { [sid('extra')]: summary('extra', 'root') },
      catalogs: { [ROOT]: catalog([child('listed')], 'loading') },
    }))
    expect(model.rows.map(row => [row.id, row.kind])).toEqual([
      [sid('listed'), 'child'],
      [sid('extra'), 'child'],
    ])
  })

  it('appends the load-error diagnostic behind the rows of a nonempty error catalog', () => {
    const model = buildAgentFlowModel(opts({
      summaries: { [sid('extra')]: summary('extra', 'root') },
      catalogs: { [ROOT]: catalog([child('listed')], 'error') },
    }))
    expect(model.rows.map(row => row.kind)).toEqual(['child', 'child', 'diagnostic'])
    expect(model.rows[2]?.diagnostic).toBe('load-error')
  })

  it('renders the loading placeholder only while an empty loading catalog has no summary children', () => {
    const placeholder = buildAgentFlowModel(opts({ catalogs: { [ROOT]: catalog([], 'loading') } }))
    expect(placeholder.rows.map(row => [row.id, row.kind])).toEqual([[ROOT, 'loading']])
    const withChildren = buildAgentFlowModel(opts({
      summaries: { [sid('kid')]: summary('kid', 'root') },
      catalogs: { [ROOT]: catalog([], 'loading') },
    }))
    expect(withChildren.rows.map(row => [row.id, row.kind])).toEqual([[sid('kid'), 'loading']])
  })

  it('renders no rows for a ready empty catalog without summary children', () => {
    const model = buildAgentFlowModel(opts({ catalogs: { [ROOT]: catalog([]) } }))
    expect(model.rows).toHaveLength(0)
    expect(model.aggregate.totalCount).toBe(0)
  })

  it('falls back from directActivity to activity to inactive on summary-less rows', () => {
    const model = buildAgentFlowModel(opts({
      catalogs: { [ROOT]: catalog([
        child('da', 'continuable', { directActivity: undefined }),
        child('none', 'continuable', { directActivity: undefined, activity: undefined }),
      ]) },
    }))
    expect(model.rows[0]?.activity).toBe('running')
    expect(model.rows[1]?.activity).toBe('inactive')
  })

  it('labels rows from the display title and falls back to the id for a blank one', () => {
    const model = buildAgentFlowModel(opts({
      summaries: {
        [sid('blank')]: summary('blank', 'root', { displayTitle: '' }),
        [sid('shown')]: summary('shown', 'root', { displayTitle: 'display' }),
      },
      catalogs: { [ROOT]: catalog([child('other')]) },
    }))
    const labelOf = (id: string) => model.rows.find(row => row.id === sid(id))?.label
    expect(labelOf('blank')).toBe('blank')
    expect(labelOf('shown')).toBe('display')
  })
})

describe('root lineage classification inputs', () => {
  it('re-derives when the root ancestor chain changes and tolerates ancestor cycles', () => {
    // Root is itself a subagent: its upward chain feeds cycle classification.
    const base = {
      summaries: {
        [ROOT]: summary('root', 'up'),
        [sid('up')]: summary('up', undefined, { origin: 'user' }),
        [sid('a')]: summary('a', 'root'),
      },
      catalogs: { [ROOT]: catalog([child('a')]) },
    }
    const builder = createAgentFlowModelBuilder()
    const first = builder.build(opts({ summaries: base.summaries, catalogs: base.catalogs }))
    const second = builder.build(opts({
      summaries: { ...base.summaries, [sid('up')]: summary('up', undefined, { origin: 'user', running: true }) },
      catalogs: base.catalogs,
    }))
    // The chain change forces re-derivation; the visible rows are unchanged.
    expect(second.rows).toBe(first.rows)
    // An ancestor cycle above the root terminates the chain walk.
    const cyclic = builder.build(opts({
      summaries: {
        [ROOT]: summary('root', 'up'),
        [sid('up')]: summary('up', 'root'),
        [sid('a')]: summary('a', 'root'),
      },
      catalogs: base.catalogs,
    }))
    expect(cyclic.rows[0]?.id).toBe(sid('a'))
  })
})

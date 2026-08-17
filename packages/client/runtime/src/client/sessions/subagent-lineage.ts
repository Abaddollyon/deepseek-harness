/**
 * Pure subagent-lineage aggregation over the retained session-list mirror.
 * Ordinary forks terminate propagation so each visible session owns only its
 * uninterrupted subagent subtree.
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/subagent-lineage
 */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from './service.ts'

/** Descendant counts projected for one possible parent session. */
export interface SubagentDescendantSummary {
  /** All descendants connected through uninterrupted subagent-origin lineage. */
  readonly count: number
  /** Descendants whose exact session summary is currently running. */
  readonly runningCount: number
}

/**
 * Index every subagent descendant under each ancestor it reaches through an
 * uninterrupted subagent-origin chain. Cycles fail soft and orphan owners
 * remain harmless map keys until their summaries arrive.
 * @param summaries - retained session summaries keyed by id.
 * @returns descendant totals and running totals keyed by possible parent id.
 */
export function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, { count: number; runningCount: number }>()
  const children = new Map<SessionId, SessionSummary[]>()
  for (const summary of Object.values(summaries)) {
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    const siblings = children.get(summary.parentId) ?? []
    siblings.push(summary)
    children.set(summary.parentId, siblings)
  }
  const cycleIds = new Set<SessionId>()
  for (const summary of Object.values(summaries)) {
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    const path = new Set<SessionId>()
    let current: SessionSummary | undefined = summary
    while (current?.origin === 'subagent' && current.parentId !== undefined) {
      if (path.has(current.id)) {
        for (const id of path) cycleIds.add(id)
        break
      }
      path.add(current.id)
      current = summaries[current.parentId]
    }
  }
  const subtreeMemo = new Map<SessionId, SubagentDescendantSummary>()
  const visiting = new Set<SessionId>()
  const subtree = (summary: SessionSummary): SubagentDescendantSummary => {
    const cached = subtreeMemo.get(summary.id)
    if (cached !== undefined) return cached
    if (visiting.has(summary.id)) return { count: 0, runningCount: 0 }
    visiting.add(summary.id)
    let count = 1
    let knownRunningCount = 0
    for (const child of children.get(summary.id) ?? []) {
      const nested = subtree(child)
      count += nested.count
      knownRunningCount += nested.runningCount
    }
    const result = {
      count,
      runningCount: (summary.running ? 1 : 0)
        + Math.max(summary.runningSubagentCount ?? 0, knownRunningCount),
    }
    visiting.delete(summary.id)
    subtreeMemo.set(summary.id, result)
    return result
  }
  for (const summary of Object.values(summaries)) {
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    if (cycleIds.has(summary.id)) {
      const seen = new Set<SessionId>()
      let current: SessionSummary | undefined = summary
      while (current?.origin === 'subagent' && current.parentId !== undefined
        && !seen.has(current.id)) {
        seen.add(current.id)
        const aggregate = indexed.get(current.parentId)
        if (aggregate === undefined) {
          indexed.set(current.parentId, {
            count: 1,
            runningCount: current.running ? 1 : 0,
          })
        } else {
          aggregate.count += 1
          aggregate.runningCount += current.running ? 1 : 0
        }
        current = summaries[current.parentId]
      }
      continue
    }
    const branch = subtree(summary)
    const aggregate = indexed.get(summary.parentId)
    if (aggregate === undefined) {
      indexed.set(summary.parentId, { ...branch })
    } else {
      aggregate.count += branch.count
      aggregate.runningCount += branch.runningCount
    }
  }
  return indexed
}

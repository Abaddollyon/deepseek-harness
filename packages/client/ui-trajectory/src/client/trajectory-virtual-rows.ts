/** Pure projection from trajectory records to measurable virtual ledger rows. */

import type { TrajectoryCellProps } from './trajectory-record.ts'
import { trajectoryRecordId } from './trajectory-record.ts'

const CONTENT_ROW_HEIGHT = 30
const COLLAPSED_SUMMARY_HEIGHT = 20
const TERMINAL_BOUNDARY_HEIGHT = 9

/** Minimal record shape required by the trajectory virtual-row projection. */
export interface VirtualizableTrajectoryRecord {
  cell: TrajectoryCellProps
  collapsedSummaryKind?: 'turn' | 'assistant'
}

/** One logical record retained inside a measurable virtual row. */
export interface TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> {
  logicalIndex: number
  record: T
}

/** One virtualizer item, which may carry zero-height request boundaries. */
export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
  entries: readonly TrajectoryVirtualRowEntry<T>[]
  height: number
  key: string
}

/**
 * Derive the DOM-safe row identity shared by React, the virtualizer, and
 * browser scroll contracts.
 * @param record - Display record whose identity is required.
 * @returns Stable record identity with a suffix for synthetic fold summaries.
 */
export function trajectoryVirtualRecordKey(
  record: VirtualizableTrajectoryRecord,
): string {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell))
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`
}

function groupRows<T extends VirtualizableTrajectoryRecord>(
  records: readonly T[],
  logicalOffset: number,
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = []
  let pending: TrajectoryVirtualRowEntry<T>[] = []

  for (const [offset, record] of records.entries()) {
    const entry = { logicalIndex: logicalOffset + offset, record }
    if (record.cell.requestOnly === true) {
      pending.push(entry)
      continue
    }
    const entries = [...pending, entry]
    pending = []
    rows.push({
      entries,
      height: record.collapsedSummaryKind === undefined
        ? CONTENT_ROW_HEIGHT
        : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    })
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map(candidate => trajectoryVirtualRecordKey(candidate.record)).join('|'),
    })
  }
  return rows
}

/**
 * Attach separator-only records to the next content row so the virtualizer
 * never owns a zero-height item. A terminal separator retains its CSS-owned
 * lower-marker clearance as a standalone item.
 * @param records - Final search/fold projection in ledger order.
 * @param logicalOffset - Ledger position of `records[0]`, added to each row's retained logical index when an earlier prefix is not loaded.
 * @returns Measurable virtual rows with original logical positions retained.
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  records: readonly T[],
  logicalOffset = 0,
): readonly TrajectoryVirtualRow<T>[] {
  return groupRows(records, logicalOffset)
}

/** Append-stable measurable-row projection owned by one trajectory view. */
export interface TrajectoryVirtualRowCache<T extends VirtualizableTrajectoryRecord> {
  /** Project records, retaining unaffected row and key identities after an append. */
  project(records: readonly T[]): readonly TrajectoryVirtualRow<T>[]
  /** Number of record visits performed by the most recent projection. */
  readonly operationCount: number
}

/**
 * Create a per-view measurable-row projection cache.
 * @returns A cache that patches the final row and appended suffix, while prepends
 * and reordered records rebuild the complete projection.
 */
export function createTrajectoryVirtualRowCache<T extends VirtualizableTrajectoryRecord>(): TrajectoryVirtualRowCache<T> {
  let previousRecords: readonly T[] = []
  let previousRows: readonly TrajectoryVirtualRow<T>[] = []
  let operationCount = 0
  return {
    get operationCount() { return operationCount },
    project(records) {
      if (records === previousRecords) {
        operationCount = 0
        return previousRows
      }
      const appendStart = previousRecords.length
      const hasPreviousPrefix = records.length >= appendStart
        && previousRecords.every((record, index) => records[index] === record)
      if (records.length === appendStart && hasPreviousPrefix) {
        operationCount = 0
        previousRecords = records
        return previousRows
      }
      const isAppend = hasPreviousPrefix
      if (!isAppend) {
        operationCount = records.length
        previousRows = groupRows(records, 0)
      } else if (appendStart === 0) {
        operationCount = records.length
        previousRows = groupRows(records, 0)
      } else {
        const last = previousRows.at(-1)
        const restart = last?.entries[0]?.logicalIndex ?? appendStart
        operationCount = appendStart + records.length - restart
        previousRows = [
          ...previousRows.filter(row => (row.entries[0]?.logicalIndex ?? restart) < restart),
          ...groupRows(records.slice(restart), restart),
        ]
      }
      previousRecords = records
      return previousRows
    },
  }
}

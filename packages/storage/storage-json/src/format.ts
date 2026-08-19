/**
 * On-disk JSON unit format: the file is always the current net state, with
 * stable key order from insertion. A unit small enough to read stays
 * pretty-printed — that legibility is this backend's reason to exist — while
 * a unit whose document exceeds the configured pretty-print ceiling is
 * published compact: pretty printing a machine-written multi-megabyte unit
 * costs about half its bytes again on every whole-file publish and buys no
 * reader anything. Both forms parse identically ({@link parse} reads whatever
 * is on the medium), so the ceiling can move without touching stored files.
 * @module @deepseek-ai/dsh-storage-json/src/format
 */

import { Buffer } from 'node:buffer'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** In-memory authoritative state of one unit; the file is its projection. `global` is `null` until first written. */
export interface UnitState {
  version: number
  global: unknown
  tables: Map<string, Map<string, unknown>>
}

/** How published files are formatted; the backend resolves it once from plugin config. */
export interface FormatPolicy {
  /**
   * Largest compact document, in UTF-8 bytes, that is still pretty-printed.
   * A unit above the ceiling publishes compact. `0` publishes every unit
   * compact; a ceiling above every unit's size keeps the backend
   * pretty-printing everything.
   */
  prettyPrintMaxBytes: number
}

/**
 * Serialize a unit state to file content.
 * @param name - Unit name, stamped into the header.
 * @param state - Authoritative in-memory state.
 * @param policy - Formatting policy deciding pretty-printed vs compact.
 * @returns the JSON document with a trailing newline, pretty-printed while
 * its compact form fits `policy.prettyPrintMaxBytes`.
 */
export function serialize(name: string, state: UnitState, policy: FormatPolicy): string {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of state.tables) {
    tables[table] = Object.fromEntries(records)
  }
  const document = {
    unit: { name, version: state.version },
    global: state.global,
    tables,
  }
  const compact = JSON.stringify(document)
  if (Buffer.byteLength(compact, 'utf8') > policy.prettyPrintMaxBytes) return `${compact}\n`
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Parse file content into unit state, validating shape and version.
 * @param text - Raw file content.
 * @param descriptor - Expected identity; version mismatch rejects.
 * @returns the parsed state.
 */
export function parse(text: string, descriptor: KvUnitDescriptor): UnitState {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not valid JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not a JSON object`)
  }
  const { unit, global: globalValue, tables } = document as Record<string, unknown>
  if (
    typeof unit !== 'object' || unit === null ||
    (unit as Record<string, unknown>)['name'] !== descriptor.name ||
    typeof (unit as Record<string, unknown>)['version'] !== 'number'
  ) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': missing or foreign unit header`)
  }
  const version = (unit as Record<string, unknown>)['version'] as number
  if (version !== descriptor.version) {
    throw new StorageError(
      'version-mismatch',
      `unit '${descriptor.name}': stored version ${version} != expected ${descriptor.version}`,
    )
  }
  if (typeof tables !== 'object' || tables === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': tables is not an object`)
  }
  const state: UnitState = { version, global: globalValue ?? null, tables: new Map() }
  for (const table of descriptor.tables) {
    const records = (tables as Record<string, unknown>)[table]
    if (records === undefined) {
      state.tables.set(table, new Map())
      continue
    }
    if (typeof records !== 'object' || records === null || Array.isArray(records)) {
      throw new StorageError('malformed-medium', `unit '${descriptor.name}': table '${table}' is not an object`)
    }
    state.tables.set(table, new Map(Object.entries(records as Record<string, unknown>)))
  }
  return state
}

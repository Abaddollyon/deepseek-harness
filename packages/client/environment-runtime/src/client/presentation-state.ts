import {
  sessionKey,
  type EnvironmentId,
  type SessionRef,
} from './identity.ts'

/** Sidebar content selected independently for each Host. */
export type EnvironmentSidebarMode = 'workspaces' | 'activity'

/** Bounded presentation state for one compound Host Session identity. */
export interface SessionPresentationState {
  /** Unsubmitted composer text. */
  readonly draft: string
  /** Selected feature or Conversation view. */
  readonly viewId: string
  /** Selected row/detail identity within the view. */
  readonly detailId?: string
  /** Stable item used to restore scroll position. */
  readonly scrollAnchor?: string
}

/** Compound-key presentation state shared across runtime switches and remounts. */
export interface EnvironmentPresentationStore {
  /** Read one Session's presentation state. */
  get(ref: SessionRef): SessionPresentationState
  /** Patch one Session's presentation state. */
  update(ref: SessionRef, patch: Partial<SessionPresentationState>): void
  /** Read one Host's sidebar mode. */
  getSidebarMode(environmentId: EnvironmentId): EnvironmentSidebarMode
  /** Set one Host's sidebar mode. */
  setSidebarMode(environmentId: EnvironmentId, mode: EnvironmentSidebarMode): void
  /** Serialize presentation-only state for bounded persistence. */
  serialize(): string
  /** Subscribe to presentation changes. */
  subscribe(listener: () => void): () => void
}

interface PersistedState {
  readonly sessions: Readonly<Record<string, SessionPresentationState>>
  readonly sidebar: Readonly<Record<string, EnvironmentSidebarMode>>
}

const EMPTY_SESSION: SessionPresentationState = Object.freeze({ draft: '', viewId: 'chat' })
const MAX_SESSIONS = 200
const MAX_TEXT = 100_000
/** Maximum UTF-16 code units written for one presentation snapshot. */
export const MAX_PRESENTATION_STORAGE_UNITS = 1_000_000

/**
 * Create compound-key presentation state from optional persisted JSON.
 * @param serialized - prior output from `serialize`; malformed input is ignored.
 * @returns observable presentation store.
 */
export function createEnvironmentPresentationStore(serialized?: string): EnvironmentPresentationStore {
  const restored = parsePersisted(serialized)
  const sessions = new Map(Object.entries(restored.sessions))
  const sidebar = new Map(Object.entries(restored.sidebar))
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    get(ref) {
      return sessions.get(sessionKey(ref)) ?? EMPTY_SESSION
    },
    update(ref, patch) {
      const key = sessionKey(ref)
      const current = sessions.get(key) ?? EMPTY_SESSION
      const next = normalizeSession({ ...current, ...patch })
      sessions.delete(key)
      sessions.set(key, next)
      while (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      publish()
    },
    getSidebarMode(environmentId) {
      return sidebar.get(environmentId) ?? 'workspaces'
    },
    setSidebarMode(environmentId, mode) {
      if (sidebar.get(environmentId) === mode) return
      sidebar.set(environmentId, mode)
      publish()
    },
    serialize() {
      const sidebarJson = JSON.stringify(Object.fromEntries(sidebar))
      const prefix = '{"sessions":{'
      const suffix = `},"sidebar":${sidebarJson}}`
      let used = prefix.length + suffix.length
      const entries: string[] = []
      // Map insertion order is recency order because update() reinserts touched sessions.
      for (const [key, value] of [...sessions].reverse()) {
        const entry = `${JSON.stringify(key)}:${JSON.stringify(value)}`
        const separator = entries.length === 0 ? 0 : 1
        if (used + separator + entry.length > MAX_PRESENTATION_STORAGE_UNITS) continue
        entries.push(entry)
        used += separator + entry.length
      }
      return `${prefix}${entries.join(',')}${suffix}`
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function parsePersisted(serialized: string | undefined): PersistedState {
  if (serialized === undefined) return { sessions: {}, sidebar: {} }
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    return { sessions: {}, sidebar: {} }
  }
  if (!isRecord(value) || !isRecord(value.sessions) || !isRecord(value.sidebar)) {
    return { sessions: {}, sidebar: {} }
  }
  const sessions: Record<string, SessionPresentationState> = {}
  for (const [key, candidate] of Object.entries(value.sessions).slice(-MAX_SESSIONS)) {
    if (!isSession(candidate)) continue
    sessions[key] = normalizeSession(candidate)
  }
  const sidebar: Record<string, EnvironmentSidebarMode> = {}
  for (const [key, candidate] of Object.entries(value.sidebar)) {
    if (candidate === 'workspaces' || candidate === 'activity') sidebar[key] = candidate
  }
  return { sessions, sidebar }
}

function normalizeSession(value: SessionPresentationState): SessionPresentationState {
  return Object.freeze({
    draft: value.draft.slice(0, MAX_TEXT),
    viewId: value.viewId.slice(0, 256),
    ...(value.detailId === undefined ? {} : { detailId: value.detailId.slice(0, 1_024) }),
    ...(value.scrollAnchor === undefined ? {} : { scrollAnchor: value.scrollAnchor.slice(0, 1_024) }),
  })
}

function isSession(value: unknown): value is SessionPresentationState {
  if (!isRecord(value) || typeof value.draft !== 'string' || typeof value.viewId !== 'string') return false
  return (value.detailId === undefined || typeof value.detailId === 'string')
    && (value.scrollAnchor === undefined || typeof value.scrollAnchor === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

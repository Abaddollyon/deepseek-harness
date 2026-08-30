/** Cold-safe Session list and search projection. */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionProjectionHints, SessionProjectionValues, SessionSearchItem,
  SessionSearchValue, SessionSummary,
} from './types.ts'

/** Default maximum artifact size eligible for one cold projection observation. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024

const COLD_SUMMARY_BATCH_SIZE = 16
const COLD_TITLE_BATCH_SIZE = 16

interface ColdTitleCacheEntry {
  readonly createdAt: number
  readonly cwd: string | undefined
  settled: boolean
  title?: SessionTitleSnapshot
}
const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  private readonly coldTitles = new Map<SessionId, ColdTitleCacheEntry>()
  private readonly warmAbortController = new AbortController()
  private readonly warmOperations = new Set<Promise<void>>()
  private disposed = false

  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param coldBlankProbeMaxBytes - maximum physical artifact size eligible for a full observation.
   */
  constructor(
    private readonly ctx: Context,
    private readonly coldBlankProbeMaxBytes: number,
  ) {
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    ctx.effect(() => async () => {
      this.disposed = true
      this.warmAbortController.abort()
      await Promise.allSettled([...this.warmOperations])
      this.coldTitles.clear()
    }, 'api-session.list.cold-titles')
    ctx.inject(['attachments'], (attachmentCtx) => {
      ctx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits,
        },
        stateVersion: 1,
      })
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.projectionsFor(session.header, session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads.
   * @returns visible summaries ordered by activity; title observations complete asynchronously
   * and retry on a later poll after a failed or cancelled batch.
   */
  async list(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionHeader[] = []
    const titleCandidates: SessionHeader[] = []
    for (const record of records) {
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        this.coldTitles.delete(record.header.id)
        items.push(this.summaryFor(live))
        continue
      }
      if (record.header.cwd === undefined) continue
      cold.push(record.header)
    }
    const visibleColdIds = new Set(cold.map(header => header.id))
    for (const sessionId of this.coldTitles.keys()) {
      if (!visibleColdIds.has(sessionId)) this.coldTitles.delete(sessionId)
    }
    for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
      const settled = await Promise.allSettled(cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE)
        .map(header => this.summarizeCold(header, signal, titleCandidates)))
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason
        items.push(result.value)
      }
    }
    this.warmColdTitles(titleCandidates, signal)
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  private async summarizeCold(
    header: SessionHeader,
    signal: AbortSignal | undefined,
    titleCandidates: SessionHeader[],
  ): Promise<SessionSummary> {
    const cached = this.projectionsFor(header, undefined)
    const projections = cached?.values.sessionListMetadata?.blank === false
      ? cached
      : await this.probeSmallCold(header, signal) ?? cached
    const visibleProjections = this.titleProjectionFor(header, projections, titleCandidates)
    const raced = this.ctx.sessions.get(header.id)
    if (raced !== undefined) return this.summaryFor(raced)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      running: false,
      // A large or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(visibleProjections === undefined ? {} : { projections: visibleProjections }),
    }
  }

  /**
   * Invalidate one cold title when its Session enters the live store.
   * @param sessionId - Session identity whose cached title must be refreshed.
   */
  invalidateColdTitle(sessionId: SessionId): void {
    this.coldTitles.delete(sessionId)
  }

  private titleProjectionFor(
    header: SessionHeader,
    projections: SessionProjectionHints | undefined,
    titleCandidates: SessionHeader[],
  ): SessionProjectionHints | undefined {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return projections
    const current = this.coldTitles.get(header.id)
    if (current !== undefined && (current.createdAt !== header.createdAt || current.cwd !== header.cwd)) this.coldTitles.delete(header.id)
    const entry = this.coldTitles.get(header.id)
    if (entry === undefined) {
      this.coldTitles.set(header.id, {
        createdAt: header.createdAt,
        cwd: header.cwd,
        settled: false,
      })
      titleCandidates.push(header)
      return projections
    }
    if (!entry.settled || entry.title === undefined) {
      if (!entry.settled) titleCandidates.push(header)
      return projections
    }
    return {
      asOfSeq: Math.max(projections?.asOfSeq ?? 0, entry.title.eventSeq),
      values: { ...projections?.values, title: entry.title.title } as SessionProjectionValues,
    }
  }

  private warmColdTitles(headers: readonly SessionHeader[], signal: AbortSignal | undefined): void {
    if (this.disposed || headers.length === 0) return
    const query = this.ctx.sessionQuery
    const operationSignal = signal === undefined
      ? this.warmAbortController.signal
      : AbortSignal.any([signal, this.warmAbortController.signal])
    const operation = (async () => {
      for (let offset = 0; offset < headers.length; offset += COLD_TITLE_BATCH_SIZE) {
        const batch = headers.slice(offset, offset + COLD_TITLE_BATCH_SIZE)
        const batchEntries = new Map<SessionId, ColdTitleCacheEntry>()
        for (const source of batch) {
          const entry = this.coldTitles.get(source.id)
          if (entry === undefined) continue
          const current = { ...entry }
          this.coldTitles.set(source.id, current)
          batchEntries.set(source.id, current)
        }
        try {
          const results = await query.readTitleSnapshots(batch.map(header => header.id), operationSignal)
          if (operationSignal.aborted) return
          for (const result of results) {
            const source = batch.find(header => header.id === result.sessionId)
            const entry = this.coldTitles.get(result.sessionId)
            const batchEntry = batchEntries.get(result.sessionId)
            if (
              source === undefined || entry === undefined || entry !== batchEntry
              || entry.createdAt !== source.createdAt || entry.cwd !== source.cwd
            ) continue
            if (this.ctx.sessions.get(result.sessionId) !== undefined) { this.coldTitles.delete(result.sessionId); continue }
            if (result.status === 'rejected') continue
            entry.settled = true
            if (result.value.session.createdAt === source.createdAt && result.value.session.cwd === source.cwd) {
              if (result.value.title !== undefined) entry.title = result.value.title
            }
          }
        } catch {
          // Keep failed entries unsettled so a later poll can retry them.
          if (signal?.aborted) return
          continue
        }
      }
    })()
    this.warmOperations.add(operation)
    void operation.then(() => { this.warmOperations.delete(operation) })
  }

  private async probeSmallCold(
    header: SessionHeader,
    signal: AbortSignal | undefined,
  ): Promise<SessionProjectionHints | undefined> {
    if (this.coldBlankProbeMaxBytes === 0) return undefined
    const persistence = this.ctx.get('sessionPersistence')
    const location = persistence?.locate(header)
    if (location === undefined) return undefined
    signal?.throwIfAborted()
    try {
      if ((await stat(location.path)).size > this.coldBlankProbeMaxBytes) return undefined
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
    try {
      using observation = await this.ctx.sessionQuery.observeSession(header.id, {
        ...(signal === undefined ? {} : { signal }),
        projectionMode: 'all',
      })
      const block = observation.projections
      return block === undefined
        ? undefined
        : { asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      this.ctx.logger.warn(
        `api-session.list: small cold observation for "${header.id}" failed; serving it as visible: ${String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      const authorized: SessionSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      const block = session === undefined
        ? header.isSeeded
          ? undefined
          : this.ctx.get('sessionProjectionCache')?.cachedSnapshot(header, SessionLogOffset(0))
        : this.ctx.sessionProjections.cachedSnapshot(session)
      return block !== undefined && Object.keys(block.values).length > 0
        ? {
          asOfSeq: block.asOfSeq,
          // Listing hints contain every currently cached wire value but remain
          // partial: missing cells and cache rows are never materialized here.
          values: block.values as SessionProjectionValues,
        }
        : undefined
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}

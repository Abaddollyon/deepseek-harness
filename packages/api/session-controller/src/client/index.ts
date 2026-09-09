/** Client Session object layer, Agent scopes, and Remote lifecycle wiring. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import { ClientSessions } from './sessions/service.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import type {} from '../remote-events.ts'

export {
  createSessionControlStream,
  SessionEventStream,
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './transport.ts'
export type {
  ClientSessionPageRequest,
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from './transport.ts'
export type { SessionFeedSnapshot } from './feed.ts'
export { createScope, scopeOf } from './scope.ts'
export type { AgentContext, AgentScopeHandle } from './scope.ts'
export { SessionCreateError, SessionForkError } from './sessions/service.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
export type {
  SessionListPhase,
  SessionListSnapshot,
  SessionSearchResultItem,
  SubagentCatalogSnapshot,
} from './sessions/manager.ts'
export type { Session } from './sessions/session.ts'
export type {
  ProjectionsBaseline,
  ProjectionValueStore,
  SessionProjectionMap,
  UseProjection,
} from './sessions/projection-store.ts'
export type {
  BeginSubmissionInput,
  ISession,
  PendingSubmissionRetirement,
  ProjectionsFace,
  SessionFace,
  SubmissionHandle,
} from './contract/session.ts'
export type { ISessions } from './contract/sessions.ts'
export { MutableSessionEventSource } from './contract/events.ts'
export type {
  AssistantLiveChunkEvent,
  SessionAssistantSettlementEntry,
  SessionEventChange,
  SessionEventLike,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from './contract/events.ts'
export type {
  OpenState,
  PendingSubmission,
  PendingSubmissionAttachment,
  PendingSubmissionFileAttachment,
  PendingSubmissionImage,
  PendingSubmissionImageAttachment,
  PendingSubmissionPlacement,
  PromptError,
  QueuedMessage,
  SessionSnapshot,
} from './contract/snapshot.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client Session object layer and Agent scope owner. */
    sessions: import('./contract/sessions.ts').ISessions
  }
}

/** Required Remote and Context projection services. */
export const inject = [
  'connection',
  'fileUpload',
  'typert',
  'remote',
  'remote.commands',
  'remote.session',
  'remote.subagents',
]

/** Client recovery timing; an empty list disables automatic service-readiness retries. */
export const Config: z<Config> = z.object({
  controlRetryDelaysMs: z.array(z.natural().max(60_000)).max(20).default([250, 500, 1000, 2000, 4000]),
})

/** Resolved Client Session recovery configuration. */
export interface Config {
  /** Millisecond delays for successive temporary service-absence retries; at most 20. */
  controlRetryDelaysMs: number[]
}

/**
 * Install Client Session state and its reconnecting control stream.
 * @param ctx - Client Cordis context.
 * @param config - Validated Client recovery schedule.
 */
export function apply(ctx: Context, config: Config): void {
  const remotes = ctx.remote as unknown as SessionRemotes
  const environmentId = (ctx.get('environmentRuntime') as { environmentId?: string } | undefined)?.environmentId
  const sessions = new ClientSessions(ctx, remotes, environmentId, config.controlRetryDelaysMs)
  ctx.remote.$on('api-session/added', (summary) => { sessions.handleSessionAdded(summary) })
  ctx.remote.$on('api-session/removed', (sessionId) => { sessions.handleSessionRemoved(sessionId) })
  ctx.remote.$on('api-session/status', (sessionId, running) => {
    sessions.handleSessionStatus(sessionId, running)
  })
  ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
    sessions.handleSessionActivity(sessionId, updatedAt)
  })
  ctx.remote.$on('api-session/error', (sessionId, message) => {
    sessions.handleSessionError(sessionId, message)
  })

  sessions.retryFeed()
  ctx.on('connection/reset', () => {
    sessions.handleConnected()
    sessions.retryFeed()
  })
  if (ctx.remote.$host.home !== undefined) sessions.handleConnected()
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.scopeOf(candidate),
    resolve: sessionId => sessions.resolveAgentScope(sessionId),
  })
}

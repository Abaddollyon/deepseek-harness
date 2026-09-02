/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through an attempt-local collection whose credential-store proxy records the
 * exact grant lazy auth supplies. The proxy still delegates every operation to
 * the durable store, while the frozen profile supplies the same provider object
 * as the operation snapshot. A retry can therefore compare the rejected grant
 * under serialized modification without mixing concurrent request identities.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { isDeepStrictEqual } from 'node:util'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  AuthContext,
  Credential,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { AUTH_FAILURE_CODE, toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface AttemptCredentialCapture {
  credential: Credential | undefined
}

type CredentialReadOptions = Parameters<CredentialStore['read']>[1]
type CredentialMutate = Parameters<CredentialStore['modify']>[1]
type CredentialModifyOptions = Parameters<CredentialStore['modify']>[2]

/** Capture the exact stored credential pi-ai resolves for one lazy request attempt. */
function capturingCredentialStore(
  source: CredentialStore,
  provider: string,
  capture: AttemptCredentialCapture,
): CredentialStore {
  // Request auth only reads and conditionally modifies the route credential.
  // Do not manufacture list/delete stubs for operations this proxy cannot serve.
  return {
    read: (_id: string, options: CredentialReadOptions) => source.read(provider, options).then((credential) => {
      capture.credential = credential
      return credential
    }),
    modify: (_id: string, mutate: CredentialMutate, options: CredentialModifyOptions) => source.modify(provider, mutate, options).then((credential) => {
      capture.credential = credential
      return credential
    }),
  } as unknown as CredentialStore
}

interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /**
   * Observe one pre-content auth-recovery cycle: the stored OAuth credential's
   * forced refresh outcome before the adapter retries the request.
   */
  onAuthRecovery?: (detail: { provider: string; refreshed: boolean; error?: string }) => void
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/**
 * Wait out one auth-recovery delay.
 * @param delayMs - the resolved pre-attempt delay.
 * @param signal - the caller's cancellation.
 * @returns false when the caller aborted before the delay elapsed.
 */
function authRecoveryDelay(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    // Auth recovery replays the whole attempt. A provider credential
    // rejection (HTTP 401/403) arrives either as the terminal finish chunk of
    // an otherwise empty stream or as a thrown error during setup; both are
    // safe to replay only while the caller has received nothing, and both
    // resolve against the credential store afresh on the next attempt, which
    // is where the forced refresh below lands its rotated token.
    let retriesLeft = profile.authRecovery.retries
    let refreshAttempted = false
    for (;;) {
      let emitted = false
      let heldUsage: Extract<StreamChunk, { type: 'usage' }> | undefined
      let authFailure: LlmFailure | undefined
      // Thrown setup failures (aborts, idle timeouts, local credential-store
      // errors) keep their own classification and propagate; pi-ai delivers
      // provider rejections as terminal error events, never as throws. The
      // attempt-local store records the credential lazy auth actually supplied.
      const attemptCredential: AttemptCredentialCapture = { credential: undefined }
      for await (const chunk of this.streamAttempt(options, profile, model, reasoning, apiKey, attemptCredential)) {
        // The terminal `usage` chunk is held back one step: on a
        // pre-content auth rejection it belongs to the abandoned attempt;
        // on success or exhausted failure it still precedes `finish`.
        if (chunk.type === 'usage') {
          heldUsage = chunk
          continue
        }
        if (!emitted
          && chunk.type === 'finish'
          && chunk.reason.kind === 'error'
          && chunk.reason.failure.code === AUTH_FAILURE_CODE) {
          authFailure = chunk.reason.failure
          break
        }
        if (heldUsage !== undefined) {
          emitted = true
          yield heldUsage
          heldUsage = undefined
        }
        emitted = true
        yield chunk
      }
      if (authFailure === undefined) return
      if (retriesLeft === 0) {
        yield heldUsage as Extract<StreamChunk, { type: 'usage' }>
        yield { type: 'finish', reason: { kind: 'error', failure: authFailure } }
        return
      }
      retriesLeft--
      if (!refreshAttempted) {
        refreshAttempted = true
        let recovery: { refreshed: boolean; error?: string } = { refreshed: false }
        if (apiKey === undefined) {
          const timeout = AbortSignal.timeout(profile.streamIdleTimeoutMs)
          const signal = options.signal === undefined
            ? timeout
            : AbortSignal.any([options.signal, timeout])
          recovery = await this.refreshStoredAuth(options.provider, attemptCredential.credential, signal)
          if (options.signal?.aborted) {
            throw new LlmError('pi-ai request aborted by caller', 'ABORTED')
          }
          if (timeout.aborted) {
            throw new LlmError(`pi-ai auth recovery idle timeout after ${profile.streamIdleTimeoutMs}ms`, 'TIMEOUT')
          }
        }
        this.config.onAuthRecovery?.({ provider: options.provider, ...recovery })
      }
      if (!await authRecoveryDelay(profile.authRecovery.delayMs, options.signal)) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED')
      }
    }
  }

  /**
   * Best-effort refresh of the route's stored OAuth credential, run once per
   * stream call before the first auth-recovery retry. pi-ai's own refresh
   * path only fires on an expired credential, so a token the provider
   * rejects early — revoked after another client rotated the shared session,
   * or dropped in an auth-backend restart — never earns one; this forces the
   * refresh while the store's `modify` exclusion still serializes it against
   * pi-ai's own.
   * @param provider - the route whose catalog OAuth handler performs the refresh.
   * @param failedCredential - exact stored credential supplied to the rejected request.
   * @param signal - combined caller and idle-timeout cancellation for lock acquisition and refresh.
   * @returns the refresh outcome; never throws, because a token-endpoint
   *   failure says nothing about whether the resource endpoint still rejects
   *   the stored credential — the retried request answers that definitively.
   */
  private async refreshStoredAuth(
    provider: string,
    failedCredential: Credential | undefined,
    signal: AbortSignal,
  ): Promise<{ refreshed: boolean; error?: string }> {
    const oauth = catalogProvider(provider)?.auth.oauth
    if (oauth === undefined) return { refreshed: false }
    try {
      // The store answers a declined mutation with the unchanged credential, so
      // the mutator itself records whether a rotation actually happened.
      let refreshed = false
      await this.config.auth.credentials.modify(provider, (current) => {
        if (current?.type !== 'oauth' || !isDeepStrictEqual(current, failedCredential)) {
          return Promise.resolve(undefined)
        }
        return oauth.refresh(current, signal).then((rotated) => {
          refreshed = true
          return rotated
        })
      }, { signal })
      return { refreshed }
    } catch (refreshError) {
      return {
        refreshed: false,
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      }
    }
  }

  private async * streamAttempt(
    options: GenerateOptions,
    profile: ResolvedPiAiProviderProfile,
    model: Model<Api>,
    reasoning: ModelThinkingLevel | undefined,
    apiKey: string | undefined,
    attemptCredential: AttemptCredentialCapture,
  ): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const attemptModels = createModels({
        credentials: capturingCredentialStore(this.config.auth.credentials, options.provider, attemptCredential),
        authContext: this.config.auth.authContext,
      })
      attemptModels.setProvider(profile.piProvider)
      const events = attemptModels.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}

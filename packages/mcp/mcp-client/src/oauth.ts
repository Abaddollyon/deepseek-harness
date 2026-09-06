/**
 * Host-owned MCP OAuth engine for one Streamable HTTP server. One
 * {@link McpOAuthConnection} owns one `GrantRecord` in `ctx.credentials`, runs
 * every OAuth protocol step through the MCP SDK's `auth()` orchestration
 * (discovery, dynamic registration, PKCE S256, code exchange, refresh) under
 * one operation queue, and hands consumers a managed fetch that attaches the
 * bearer token itself. The SDK transport therefore receives no
 * `authProvider`: it can neither spend a rotating refresh token concurrently
 * nor open an authorization flow on an ordinary 401.
 *
 * Interactive authorization runs only inside {@link McpOAuthConnection.authorize}
 * with the `AuthorizationSession` the authorization seam supplied: the engine
 * notifies the authorization URL, asks for the complete callback URL through
 * a secret prompt, and validates the registered redirect, the random state,
 * the issuer when advertised, and a single code. No callback listener or port
 * is created. Code, verifier, and state live only in the operation's memory;
 * the durable record is written once, at commit, and every commit is a
 * compare-and-set on the record epoch the operation observed, so a revoked,
 * disposed, or superseded operation cannot resurrect a grant even when it
 * ignores its abort.
 *
 * @module
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { auth as sdkAuth, selectClientAuthMethod } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpOAuthError } from './oauth-error.ts'
import { createBoundedFetch, requestUrl } from './oauth-fetch.ts'
import {
  ClientInformationSchema, GrantDocumentSchema, bindingDocument, resolveMcpOAuthSpec, validateDiscovery, viewGrantRecord,
} from './oauth-record.ts'
import type { GrantDocument, GrantView, McpOAuthSpec, ResolvedMcpOAuthSpec, ValidatedDiscovery } from './oauth-record.ts'

export { McpOAuthError, isMcpOAuthError } from './oauth-error.ts'
export type { McpOAuthErrorCode } from './oauth-error.ts'
export { resolveMcpOAuthSpec } from './oauth-record.ts'
export type { GrantDocument, McpOAuthBinding, McpOAuthSpec, ResolvedMcpOAuthSpec } from './oauth-record.ts'

/** The credential seam members the engine uses; pass `ctx.credentials`. */
export type McpOAuthCredentialStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>

/** Token-free lifecycle facts for status surfaces. */
export interface McpOAuthStatus {
  /** Whether a grant can currently serve requests. */
  state: 'auth-required' | 'authorized' | 'revoked' | 'disposed'
  /** Why no grant serves, while `state` is `auth-required`. */
  reason?: 'no-grant' | 'record-invalid' | 'binding-changed' | 'grant-invalidated'
  /** The engine operation running now, if any. */
  inFlight: 'authorize' | 'refresh' | undefined
  /** Whether the stored grant can be refreshed without the human. */
  hasRefreshToken: boolean
  /** Advertised access-token expiry as epoch milliseconds; absent when the server advertised none. */
  accessTokenExpiresAt: number | undefined
  /** Effective granted scope: the server's `scope` response, else the scope the grant already had (RFC 6749 §5.1, §6). */
  grantedScope: string | undefined
  /** Record epoch; absent while nothing valid is stored, and while locally revoked, when the store is not consulted. */
  epoch: number | undefined
}

/**
 * Transitions the engine reports; the bridge resyncs or drops tools on them.
 * All but `revoked` and `disposed` are reported once committed; `revoked` is
 * reported at the first synchronous step of revocation, before its tombstone
 * is stored, because consumers must stop at once.
 */
export type McpOAuthChange = 'authorized' | 'refreshed' | 'invalidated' | 'revoked' | 'disposed'

/**
 * One authority transition. Committed changes carry their own epoch and
 * effective scope, not a later status read another commit may have overtaken.
 * A `revoked` event reports immediate local refusal, not a durable-write acknowledgement.
 */
export interface McpOAuthChangeEvent {
  /** The transition. */
  kind: McpOAuthChange
  /**
   * Record epoch the commit wrote; absent for `disposed`, which writes
   * nothing, and for `revoked`, which is reported before its tombstone is stored.
   */
  epoch: number | undefined
  /** Effective granted scope of the committed grant; absent unless `authorized` or `refreshed`. */
  grantedScope: string | undefined
}

/** Outcome of {@link McpOAuthConnection.revoke}; the local tombstone is committed before any remote attempt. */
export interface McpOAuthRevocation {
  local: 'revoked'
  /** `no-grant` when nothing was stored, `unsupported` when the server advertises no revocation endpoint. */
  remote: 'no-grant' | 'unsupported' | 'succeeded' | 'failed'
}

/** Injected dependencies; production callers supply none. */
export interface McpOAuthOptions {
  /** External fetch beneath the engine's own validation and bounds. Defaults to global fetch. */
  fetch?: FetchLike
  /** Clock for token expiry. Defaults to `Date.now`. */
  now?: () => number
  /** Observer of committed transitions; a throwing observer is contained. */
  onChange?: (event: McpOAuthChangeEvent) => void
}

/** Request headers a managed request may not supply itself. */
const MANAGED_HEADERS = ['authorization', 'proxy-authorization', 'cookie']

const CALLBACK_PROMPT = 'Approve access in your browser, then paste the complete URL of the page you were redirected to.'
const REDIRECT_NOTICE = 'Open this page to approve access for the MCP server.'

/** Memory-only material of one operation; discarded with the operation. */
interface Staged {
  discovery: ValidatedDiscovery | undefined
  clientInformation: OAuthClientInformationMixed | undefined
  tokens: OAuthTokens | undefined
  state: string | undefined
  codeVerifier: string | undefined
  verifierConsumed: boolean
  tokensInvalidated: boolean
  /** Last bounded-fetch failure, reported when the SDK swallows it and asks for a redirect instead. */
  failure: McpOAuthError | undefined
}

/** One authorize or refresh operation: its abort owner, CAS target, and staged material. */
class Operation {
  readonly controller = new AbortController()
  readonly staged: Staged
  /** Record epoch every commit of this operation must find; advanced by its own commits. */
  expectedEpoch: number | undefined

  constructor(
    readonly kind: 'authorize' | 'refresh',
    expectedEpoch: number | undefined,
    seed: Partial<Pick<Staged, 'discovery' | 'clientInformation' | 'tokens'>>,
    /** Revocation count when the operation's caller entered; a commit is refused once it moved. */
    readonly entered: number,
  ) {
    this.expectedEpoch = expectedEpoch
    this.staged = {
      discovery: seed.discovery,
      clientInformation: seed.clientInformation,
      tokens: seed.tokens,
      state: undefined,
      codeVerifier: undefined,
      verifierConsumed: false,
      tokensInvalidated: false,
      failure: undefined,
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw this.signal.reason as Error
  }

  /** The error the operation's caller sees: the abort reason once aborted, else the failure itself. */
  settle(error: unknown): unknown {
    return this.signal.aborted ? this.signal.reason as unknown : error
  }
}

/** The signal's abort reason once it fired during the failed work, else the failure itself. */
function abortReasonOr(signal: AbortSignal, failure: unknown): unknown {
  return signal.aborted ? signal.reason as unknown : failure
}

/** An engine error as-is; any other failure becomes `NETWORK` with a sanitized cause. */
function asEngineError(reason: unknown): McpOAuthError {
  return reason instanceof McpOAuthError ? reason : new McpOAuthError('managed request failed', 'NETWORK', { cause: reason })
}

/** Canonical JSON of a payload: object keys sorted at every level, so the same document fingerprints the same wherever it was parsed. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
    // Keys of one object are distinct, so two never compare equal.
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
  })
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function noop(): void {}

function protocolError(message: string, cause?: unknown): McpOAuthError {
  return new McpOAuthError(message, 'PROTOCOL', cause === undefined ? undefined : { cause })
}

function callbackInvalid(message: string): McpOAuthError {
  return new McpOAuthError(`callback URL rejected: ${message}`, 'CALLBACK_INVALID')
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Whether a request body can be sent a second time after a 401. */
function replayable(body: BodyInit | null | undefined): boolean {
  return body === undefined || body === null || typeof body === 'string' || body instanceof URLSearchParams
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob || body instanceof FormData
}

/**
 * Wait for engine-owned work on behalf of one consumer: the consumer's abort
 * releases the consumer while the work continues under the engine's bounds.
 */
function awaitFor<T>(work: Promise<T>, consumer: AbortSignal): Promise<T> {
  if (consumer.aborted) return Promise.reject(consumer.reason as Error)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(consumer.reason as Error) }
    consumer.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => { consumer.removeEventListener('abort', abort) })
  })
}

/**
 * Engine for one MCP server's OAuth grant. Construct one per server in the
 * Host; share it among every consumer of that server.
 */
export class McpOAuthConnection {
  /** The resolved spec this engine enforces. */
  readonly spec: ResolvedMcpOAuthSpec
  private readonly store: McpOAuthCredentialStore
  private readonly external: FetchLike
  private readonly now: () => number
  private readonly onChange: ((event: McpOAuthChangeEvent) => void) | undefined
  /**
   * Canonical fingerprint of the record this engine last stored, plus the
   * fingerprints of writes still inside the store. Recorded inside the
   * store's write so a `record-updated` observer can already tell the write is
   * ours; bounded because a superseded write is no longer an identity this
   * engine vouches for — an older own record put back by someone else is an
   * external change, and so is a payload altered under the same epoch.
   */
  private ownLatest: string | undefined
  private readonly ownPending = new Set<string>()
  private readonly clientMetadata: OAuthClientMetadata
  /** Aborted once at dispose; bounds every engine-owned request. */
  private readonly lifecycle = new AbortController()
  /** Aborted and replaced at revoke so in-flight managed requests stop before the tombstone is even written. */
  private grant = new AbortController()
  private disposed = false
  /**
   * Set at the first synchronous step of {@link revoke} and cleared only by
   * an explicit authorization that commits a new grant. While set, no token
   * is served, refreshed, or sent — whatever the durable record still says,
   * because the tombstone write may be pending or may have failed.
   */
  private locallyRevoked = false
  /**
   * Count of revocations latched so far. An authorization captures it on
   * entry — before its first await — and is refused at its start and at its
   * commit if a revocation was latched since: an attempt that only entered
   * before the revocation is not the explicit recovery from it.
   */
  private revocations = 0
  /** Serializes authorize and refresh operations; its tail never rejects. */
  private queue: Promise<unknown> = Promise.resolve()
  private current: Operation | undefined
  private authorizing = false
  /** The refresh every waiting consumer shares; cleared when it settles. */
  private refreshing: Promise<void> | undefined
  /**
   * Record epoch whose access token a managed request saw rejected. That
   * token is never sent again: every later acquisition refreshes first, one
   * shared attempt per acquiring call, until a commit moves the record past
   * this epoch or the grant is invalidated. A transient refresh failure
   * leaves it set on purpose — clearing it would resend a known-rejected token.
   */
  private rejectedEpoch: number | undefined
  /** Out-of-queue work (remote revocation) dispose must await. */
  private readonly work = new Set<Promise<unknown>>()

  constructor(store: McpOAuthCredentialStore, spec: McpOAuthSpec, options: McpOAuthOptions = {}) {
    this.spec = resolveMcpOAuthSpec(spec)
    this.store = store
    this.external = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.onChange = options.onChange
    this.clientMetadata = {
      redirect_uris: [this.spec.redirectUri.href],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.spec.clientName,
      ...(this.spec.scopes.length === 0 ? {} : { scope: this.spec.scopes.join(' ') }),
    }
  }

  /**
   * Token-free lifecycle facts read from the durable record — except while
   * disposed or locally revoked, which are facts of this engine reported
   * without a store read.
   * @returns the current status.
   */
  async status(): Promise<McpOAuthStatus> {
    const inFlight: McpOAuthStatus['inFlight'] = this.authorizing ? 'authorize' : this.refreshing === undefined ? undefined : 'refresh'
    const base = { inFlight, hasRefreshToken: false, accessTokenExpiresAt: undefined, grantedScope: undefined, epoch: undefined }
    if (this.disposed) return { state: 'disposed', ...base }
    // The local refusal is a fact of this engine, reported without touching the store: a store that hangs or
    // fails must not delay or hide it, and the durable epoch is truthfully unknown here.
    if (this.locallyRevoked) return { state: 'revoked', ...base }
    const view = await this.readView()
    switch (view.kind) {
      case 'none': return { state: 'auth-required', reason: 'no-grant', ...base }
      case 'invalid': return { state: 'auth-required', reason: 'record-invalid', ...base }
      case 'foreign': return { state: 'auth-required', reason: 'binding-changed', ...base, epoch: view.epoch }
      case 'grant': {
        const { doc } = view
        if (doc.status === 'revoked') return { state: 'revoked', ...base, epoch: view.epoch }
        if (doc.status === 'invalidated' || doc.tokens === undefined) return { state: 'auth-required', reason: 'grant-invalidated', ...base, epoch: view.epoch }
        return {
          state: 'authorized',
          inFlight,
          hasRefreshToken: doc.tokens.refresh_token !== undefined,
          accessTokenExpiresAt: this.expiresAt(doc),
          grantedScope: doc.tokens.scope,
          epoch: view.epoch,
        }
      }
    }
  }

  /**
   * Run one explicit, human-driven authorization: discovery, registration
   * when no client id is configured, the authorization URL notice, the
   * callback prompt, and the code exchange. Always runs a fresh code flow —
   * an existing grant is replaced, never silently refreshed. Resolves once the
   * new grant is committed to the credential record.
   * @param session - the authorization seam's session for this attempt.
   * @throws {McpOAuthError} `ALREADY_IN_FLIGHT`, `CANCELLED`, `DISPOSED`, `STALE`, `CALLBACK_INVALID`,
   *   `DISCOVERY_REJECTED`, `ENDPOINT_NOT_ALLOWED`, `NETWORK`, `RESPONSE_BOUND`, or `PROTOCOL`; a declined
   *   prompt rethrows the surface's own rejection.
   */
  async authorize(session: AuthorizationSession): Promise<void> {
    this.assertLive()
    if (this.authorizing) throw new McpOAuthError('an authorization attempt is already running for this MCP server', 'ALREADY_IN_FLIGHT')
    if (session.signal.aborted) throw new McpOAuthError('the authorization attempt was cancelled', 'CANCELLED', { cause: session.signal.reason })
    const entered = this.revocations
    this.authorizing = true
    try {
      await this.enqueue(async () => {
        this.assertLive()
        this.assertNotRevokedSince(entered)
        const view = await this.readView()
        this.assertNotRevokedSince(entered)
        const op = new Operation('authorize', view.epoch, view.kind === 'grant'
          ? { discovery: view.discovery, clientInformation: view.doc.clientInformation }
          : {}, entered)
        const withdraw = (): void => {
          op.controller.abort(new McpOAuthError('the authorization attempt was cancelled', 'CANCELLED', { cause: session.signal.reason }))
        }
        session.signal.addEventListener('abort', withdraw, { once: true })
        // A withdrawal that landed while the record was being read has no listener to fire.
        if (session.signal.aborted) withdraw()
        this.current = op
        try {
          await this.runAuthorize(op, session)
        } catch (error) {
          throw op.settle(error)
        } finally {
          session.signal.removeEventListener('abort', withdraw)
          this.current = undefined
        }
      })
    } finally {
      this.authorizing = false
    }
  }

  /**
   * A fetch for one consumer that attaches the current bearer token to
   * requests for exactly the configured MCP endpoint URL, refreshing through
   * the engine's single shared refresh when the token is expiring or was just
   * rejected. Only a 401 is acted on: one shared refresh and one retry with a
   * replayable body, and a 401 after that invalidates the grant; timeouts,
   * network failures, and every other status are returned or thrown as they
   * are. Nothing here opens an authorization flow. Pass it as the SDK
   * transport's `fetch` with no `authProvider`. Response bodies stream
   * untouched.
   * @param consumer - aborts this consumer's requests and its wait for a shared refresh.
   * @returns a fetch bound to that consumer.
   * @throws {McpOAuthError} `ENDPOINT_NOT_ALLOWED` for any URL but the endpoint, `MANAGED_HEADER` for a supplied
   *   credential header, `AUTH_REQUIRED` when no grant serves, `DISPOSED`, `REFRESH_FAILED`, or `NETWORK` with a
   *   sanitized cause when the request itself fails.
   */
  authenticatedFetch(consumer: AbortSignal): FetchLike {
    return async (input, init) => {
      this.assertLive()
      const url = requestUrl(input)
      if (url.href !== this.spec.serverUrl.href) {
        throw new McpOAuthError('managed request targets a URL other than the configured MCP endpoint', 'ENDPOINT_NOT_ALLOWED')
      }
      const headers = new Headers(init?.headers)
      for (const name of MANAGED_HEADERS) {
        if (headers.has(name)) throw new McpOAuthError(`managed request may not supply a ${name} header`, 'MANAGED_HEADER')
      }
      const signal = AbortSignal.any([consumer, this.grant.signal, this.lifecycle.signal, ...(init?.signal ? [init.signal] : [])])
      const send = async (accessToken: string): Promise<Response> => {
        // Revocation or disposal during the token acquisition wins before any byte leaves.
        if (signal.aborted) throw asEngineError(signal.reason)
        headers.set('authorization', `Bearer ${accessToken}`)
        try {
          return await new Promise<Response>((resolve) => {
            resolve(this.external(url, { ...init, headers, signal, redirect: 'error', credentials: 'omit' }))
          })
        } catch (error) {
          throw asEngineError(abortReasonOr(signal, error))
        }
      }
      const first = await this.acquire(signal)
      const response = await send(first.accessToken)
      if (response.status !== 401) return response
      // The rejection is remembered whether or not this request can be retried, so the next acquisition refreshes first.
      this.rejectedEpoch = first.epoch
      // A body that was streamed cannot be sent again; the 401 is the caller's to handle.
      if (!replayable(init?.body)) return response
      response.body?.cancel().catch(noop)
      const second = await this.acquire(signal)
      const retried = await send(second.accessToken)
      if (retried.status === 401) await awaitFor(this.rejectGrant(second.epoch), consumer)
      return retried
    }
  }

  /**
   * Revoke locally first — in-flight managed requests and the running
   * operation are aborted before the first await, and the tombstone is
   * committed unconditionally — then attempt RFC 7009 revocation at the
   * discovered endpoint within the engine's bounds.
   * The local revocation is latched and reported before the first await, so
   * a request arriving while the tombstone write is pending — or after it
   * failed — is refused rather than served from the record the store still
   * holds. Only an explicit re-authorization lifts the latch.
   * @returns local and remote outcomes; the remote one is reported truthfully, never assumed.
   * @throws {McpOAuthError} `DISPOSED`; `STORE` when the tombstone write is not confirmed — the engine
   *   stays locally revoked; the durable outcome requires reconciliation.
   */
  async revoke(): Promise<McpOAuthRevocation> {
    this.assertLive()
    const alreadyLatched = this.locallyRevoked
    this.locallyRevoked = true
    this.revocations += 1
    this.rotateGrant(new McpOAuthError('the grant was revoked', 'AUTH_REQUIRED'))
    this.current?.controller.abort(new McpOAuthError('the grant was revoked while this operation ran', 'AUTH_REQUIRED'))
    this.rejectedEpoch = undefined
    // Consumers stop now; the tombstone that follows is the engine's own write and raises no second withdrawal.
    if (!alreadyLatched) this.emit({ kind: 'revoked', epoch: undefined, grantedScope: undefined })
    let previous: GrantDocument | undefined
    try {
      await this.write((current) => {
        const view = viewGrantRecord(current, this.spec)
        previous = view.kind === 'grant' ? view.doc : undefined
        return {
          format: 1,
          binding: bindingDocument(this.spec.binding),
          epoch: (view.epoch ?? 0) + 1,
          status: 'revoked',
          ...(previous?.clientInformation === undefined ? {} : { clientInformation: previous.clientInformation }),
          ...(previous?.discovery === undefined ? {} : { discovery: previous.discovery }),
        }
      })
    } catch (error) {
      throw error instanceof McpOAuthError
        ? error
        : new McpOAuthError('the credential store did not confirm the revocation tombstone; the grant is revoked here and its stored state is unknown', 'STORE', { cause: error })
    }
    const revoked: GrantDocument | undefined = previous
    if (revoked?.tokens === undefined) return { local: 'revoked', remote: 'no-grant' }
    const remote = this.revokeRemotely(revoked, revoked.tokens)
    this.work.add(remote)
    try {
      return { local: 'revoked', remote: await remote }
    } finally {
      this.work.delete(remote)
    }
  }

  /**
   * Abort every owned operation and managed request, refuse further use, and
   * resolve only once the queue and out-of-queue work have settled.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const reason = new McpOAuthError('the MCP OAuth engine was disposed', 'DISPOSED')
    this.lifecycle.abort(reason)
    this.rotateGrant(reason)
    this.current?.controller.abort(reason)
    await Promise.allSettled([this.queue, ...this.work])
    this.emit({ kind: 'disposed', epoch: undefined, grantedScope: undefined })
  }

  /**
   * Whether a stored record is one this engine wrote. A `credentials/record-updated`
   * observer that reads the record and asks this tells the engine's own
   * commits — already reported through `onChange` — from an external edit,
   * deletion, or another process's write, which it must treat as a change
   * of authority.
   * @param record - the record as the credential store returned it.
   * @returns true only for exactly the record this engine last stored or is storing now.
   */
  ownsRecord(record: CredentialRecord | undefined): boolean {
    return this.captureOwnership()(record)
  }

  /**
   * The identities this engine vouches for at this instant — the record it
   * last stored and the writes inside the store right now — as a classifier
   * an observer can apply later. A `credentials/record-updated` observer
   * captures it synchronously at the event and classifies the record its
   * asynchronous read returns against that capture, so a write this engine
   * makes afterwards can neither hide the change the event announced nor
   * turn its own later record into a spurious external one when the read
   * returns the record as it stood at the event.
   * @returns a classifier over the bounded identities captured now.
   */
  captureOwnership(): (record: CredentialRecord | undefined) => boolean {
    const identities = new Set(this.ownPending)
    if (this.ownLatest !== undefined) identities.add(this.ownLatest)
    return record => record?.kind === 'grant' && identities.has(canonical(record.payload))
  }

  /**
   * Store one document through the credential seam, vouching for exactly
   * that payload from inside the write until the write settles: a write the
   * store rejects is not vouched for afterwards, so whatever it left behind
   * reads as external (a spurious withdrawal, never a missed one).
   */
  private async write(build: (current: CredentialRecord | undefined) => GrantDocument): Promise<GrantDocument> {
    let written: { document: GrantDocument; fingerprint: string } | undefined
    try {
      await this.store.modifyRecord(this.spec.key, (current) => {
        const document = build(current)
        const payload = json(document)
        written = { document, fingerprint: canonical(payload) }
        this.ownPending.add(written.fingerprint)
        return Promise.resolve({ kind: 'grant', payload })
      })
    } finally {
      if (written !== undefined) this.ownPending.delete(written.fingerprint)
    }
    if (written === undefined) throw protocolError('the credential store declined the commit')
    this.ownLatest = written.fingerprint
    return written.document
  }

  private async runAuthorize(op: Operation, session: AuthorizationSession): Promise<void> {
    const provider = this.providerFor(op, session)
    const fetchFn = this.boundedFetch(op)
    const requested = this.requestedScope()
    const scope = requested === undefined ? {} : { scope: requested }
    // The SDK resolves the first call only after redirectToAuthorization ran (tokens() is undefined
    // here, so it never refreshes), and the second only after saveTokens committed the grant; the
    // callback check below refuses to continue without the state that redirect produced.
    op.throwIfAborted()
    await this.protocol(() => sdkAuth(provider, { serverUrl: this.spec.serverUrl, fetchFn, ...scope }))
    const callback = await this.promptCallback(op, session)
    const code = this.acceptCallback(callback, op)
    await this.protocol(() => sdkAuth(provider, { serverUrl: this.spec.serverUrl, fetchFn, authorizationCode: code, ...scope }))
  }

  /** Ask for the callback URL, racing the prompt against the operation so a surface that ignores withdrawal cannot wedge the engine. */
  private promptCallback(op: Operation, session: AuthorizationSession): Promise<string> {
    op.throwIfAborted()
    const prompt = session.prompt({ kind: 'secret', message: CALLBACK_PROMPT, signal: op.signal })
    // A prompt that settles after the race was lost has nobody left to hear it.
    prompt.catch(noop)
    return awaitFor(prompt, op.signal)
  }

  /** Validate the pasted callback URL against this operation and return its single code. */
  private acceptCallback(raw: string, op: Operation): string {
    let callback: URL
    try {
      callback = new URL(raw.trim())
    } catch {
      // Whatever was pasted is not a URL; the message stays generic so the paste is never echoed.
      throw callbackInvalid('not an absolute URL')
    }
    const redirect = this.spec.redirectUri
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash !== '' || callback.username !== '' || callback.password !== '') {
      throw callbackInvalid('it does not match the registered redirect URI')
    }
    const params = callback.searchParams
    if (params.has('error')) throw callbackInvalid('the authorization server denied the request')
    const states = params.getAll('state')
    if (op.staged.state === undefined || states.length !== 1 || !sameSecret(states[0] as string, op.staged.state)) {
      throw callbackInvalid('state does not match this authorization attempt')
    }
    const metadata = op.staged.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined
    const issuers = params.getAll('iss')
    if (metadata?.['authorization_response_iss_parameter_supported'] === true || issuers.length > 0) {
      if (issuers.length !== 1 || !URL.canParse(issuers[0] as string) || new URL(issuers[0] as string).href !== this.spec.issuerUrl.href) {
        throw callbackInvalid('issuer does not match the expected issuer')
      }
    }
    const codes = params.getAll('code')
    if (codes.length !== 1 || codes[0] === '') throw callbackInvalid('exactly one authorization code is required')
    return codes[0] as string
  }

  /** Run one SDK step, surfacing SDK and server failures as `PROTOCOL` with the cause attached. */
  private async protocol<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step()
    } catch (error) {
      if (error instanceof McpOAuthError) throw error
      throw protocolError('the authorization server or OAuth client library rejected a protocol step', error)
    }
  }

  /** The SDK provider for one operation: interactive only when a session is attached, and then for exactly one redirect. */
  private providerFor(op: Operation, session?: AuthorizationSession): OAuthClientProvider {
    const { staged } = op
    const spec = this.spec
    const clientMetadata = this.clientMetadata
    const interactive = session !== undefined
    return {
      get redirectUrl(): string { return spec.redirectUri.href },
      get clientMetadata(): OAuthClientMetadata { return { ...clientMetadata } },
      state: () => {
        staged.state = randomBytes(32).toString('base64url')
        return staged.state
      },
      clientInformation: () => this.clientInformationOf(staged),
      saveClientInformation: (information) => {
        // The SDK validated the registration response; parsing again keeps only the stored fields.
        const registered = ClientInformationSchema.parse(information)
        if ('redirect_uris' in registered && !registered.redirect_uris.some(uri => URL.canParse(uri) && new URL(uri).href === spec.redirectUri.href)) {
          throw new McpOAuthError('client registration did not accept the configured redirect URI', 'DISCOVERY_REJECTED')
        }
        staged.clientInformation = registered
      },
      tokens: () => (interactive || staged.tokensInvalidated ? undefined : staged.tokens),
      saveTokens: async (tokens) => { await this.commitTokens(op, tokens) },
      redirectToAuthorization: (url) => {
        if (!interactive) {
          throw staged.failure ?? (staged.tokensInvalidated
            ? new McpOAuthError('the authorization server rejected the stored grant', 'AUTH_REQUIRED')
            : new McpOAuthError('the stored grant could not be refreshed', 'REFRESH_FAILED'))
        }
        // The SDK builds this URL from the authorization_endpoint that saveDiscoveryState validated.
        op.throwIfAborted()
        session.notify({ message: REDIRECT_NOTICE, url: url.href })
      },
      saveCodeVerifier: (verifier) => {
        staged.codeVerifier = verifier
        staged.verifierConsumed = false
      },
      codeVerifier: () => {
        if (!interactive || staged.codeVerifier === undefined || staged.verifierConsumed) throw protocolError('the PKCE verifier is unavailable')
        staged.verifierConsumed = true
        return staged.codeVerifier
      },
      // Resource metadata already had to name exactly this resource in saveDiscoveryState.
      validateResourceURL: () => Promise.resolve(new URL(spec.resourceUrl.href)),
      saveDiscoveryState: (state) => { staged.discovery = validateDiscovery(state, spec) },
      discoveryState: () => staged.discovery,
      invalidateCredentials: async (scope) => {
        // The SDK asks for 'tokens' after invalid_grant and 'all' after invalid_client; either way the
        // grant is unusable, and only a complete invalidation also discards registration and discovery.
        staged.tokensInvalidated = true
        if (scope === 'all') {
          staged.discovery = undefined
          staged.clientInformation = undefined
        }
        if (!interactive) await this.commitInvalidation(op, scope === 'all' ? 'all' : 'tokens')
      },
    }
  }

  /** Staged registration, else the configured public client id. */
  private clientInformationOf(staged: Staged): OAuthClientInformationMixed | undefined {
    return staged.clientInformation ?? (this.spec.clientId === undefined ? undefined : { client_id: this.spec.clientId })
  }

  private boundedFetch(op: Operation): FetchLike {
    return createBoundedFetch(this.external, this.spec, op.signal, (failure) => { op.staged.failure = failure })
  }

  /** Commit the authorized grant this operation produced, once discovery and registration were validated. */
  private async commitTokens(op: Operation, tokens: OAuthTokens): Promise<void> {
    const parsed = OAuthTokensSchema.safeParse(tokens)
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') throw protocolError('token response is not a bearer token response')
    // A response without `scope` grants what was requested (RFC 6749 §5.1) or, on refresh, what the grant
    // already had (§6); the effective scope is stored so status and observers never mistake omission for narrowing.
    const inherited = op.kind === 'authorize' ? this.requestedScope() : op.staged.tokens?.scope
    const scope = parsed.data.scope ?? inherited
    const effective: OAuthTokens = { ...parsed.data, ...(scope === undefined ? {} : { scope }) }
    // Discovery and registration staged so far; the document schema refuses an authorized grant without them.
    const committed = await this.commit(op, epoch => ({
      format: 1,
      binding: bindingDocument(this.spec.binding),
      epoch,
      status: 'authorized',
      tokens: effective,
      tokensIssuedAt: this.now(),
      clientInformation: this.clientInformationOf(op.staged),
      discovery: op.staged.discovery,
    }))
    // Publication is a further hop after the commit resolved; a revocation or abort that landed in that hop
    // means the stored document stands but nothing is published from it and the latch stays.
    op.throwIfAborted()
    this.assertNotRevokedSince(op.entered)
    op.staged.tokens = effective
    this.rejectedEpoch = undefined
    // A newly committed grant from an attempt entered after every latched revocation is the explicit recovery.
    if (op.kind === 'authorize') this.locallyRevoked = false
    this.emit({ kind: op.kind === 'authorize' ? 'authorized' : 'refreshed', epoch: committed.epoch, grantedScope: scope })
  }

  /** The requested scope string, or undefined when the server chooses. */
  private requestedScope(): string | undefined {
    return this.spec.scopes.length === 0 ? undefined : this.spec.scopes.join(' ')
  }

  /** Commit that the server rejected the grant, dropping the tokens; `all` also drops registration and discovery. */
  private async commitInvalidation(op: Operation, scope: 'all' | 'tokens'): Promise<void> {
    const committed = await this.commit(op, epoch => ({
      format: 1,
      binding: bindingDocument(this.spec.binding),
      epoch,
      status: 'invalidated',
      ...(scope === 'all' ? {} : this.retained(op.staged)),
    }))
    this.emit({ kind: 'invalidated', epoch: committed.epoch, grantedScope: undefined })
  }

  /** Registration and discovery of the grant being invalidated, kept so re-authorization can skip both. */
  private retained(staged: Staged): Pick<GrantDocument, 'clientInformation' | 'discovery'> {
    const kept: Pick<GrantDocument, 'clientInformation' | 'discovery'> = {}
    const entries = Object.entries({ clientInformation: this.clientInformationOf(staged), discovery: staged.discovery })
    for (const [key, value] of entries.filter(entry => entry[1] !== undefined)) Object.assign(kept, { [key]: value })
    return kept
  }

  /**
   * The one durable write path: a compare-and-set on the epoch this operation
   * observed, refused once the operation is aborted or the engine disposed.
   */
  private async commit(op: Operation, build: (epoch: number) => GrantDocument): Promise<GrantDocument> {
    let committed: GrantDocument
    try {
      committed = await this.write((current) => {
        op.throwIfAborted()
        this.assertLive()
        this.assertNotRevokedSince(op.entered)
        const view = viewGrantRecord(current, this.spec)
        if (view.epoch !== op.expectedEpoch) {
          throw new McpOAuthError('the grant changed while this operation ran; its result was discarded', 'STALE')
        }
        // The document is validated on the way in, like every record read: what is stored always parses.
        return GrantDocumentSchema.parse(build((view.epoch ?? 0) + 1))
      })
    } catch (error) {
      // The SDK swallows non-OAuth failures of a refresh and asks for a redirect instead; the recorded
      // failure is what the redirect refusal reports.
      if (error instanceof McpOAuthError) op.staged.failure = error
      throw error
    }
    // The store may have acknowledged a document it stored while this operation was being aborted or a
    // revocation latched; what it stored stands, but this operation reports nothing from it.
    op.throwIfAborted()
    this.assertNotRevokedSince(op.entered)
    op.expectedEpoch = committed.epoch
    return committed
  }

  /** A usable access token, refreshing through the shared refresh when the stored one is expiring or rejected. */
  private async acquire(consumer: AbortSignal): Promise<{ accessToken: string; epoch: number }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.assertNotRevoked()
      const view = await this.readView()
      const usable = this.usable(view)
      if (usable !== undefined) return usable
      if (view.kind !== 'grant' || view.doc.status !== 'authorized') throw this.authRequired(view)
      await awaitFor(this.refresh(), consumer)
    }
    throw new McpOAuthError('token refresh did not yield a usable access token', 'REFRESH_FAILED')
  }

  private usable(view: GrantView): { accessToken: string; epoch: number } | undefined {
    if (view.kind !== 'grant' || view.doc.status !== 'authorized' || view.doc.tokens === undefined) return undefined
    if (this.rejectedEpoch === view.epoch) return undefined
    const expiresAt = this.expiresAt(view.doc)
    if (expiresAt !== undefined && this.now() + this.spec.refreshLeewayMs >= expiresAt) return undefined
    return { accessToken: view.doc.tokens.access_token, epoch: view.epoch }
  }

  /** The shared refresh: every caller joins the running one; the next starts only after it settled. */
  private refresh(): Promise<void> {
    if (this.refreshing === undefined) {
      const run = this.enqueue(() => this.runRefresh())
      const shared = run.finally(() => { this.refreshing = undefined })
      // Every joiner awaits it; a joiner that left early must not turn its failure into an unhandled rejection.
      shared.catch(noop)
      this.refreshing = shared
    }
    return this.refreshing
  }

  private async runRefresh(): Promise<void> {
    this.assertLive()
    this.assertNotRevoked()
    const view = await this.readView()
    if (view.kind !== 'grant' || view.doc.status !== 'authorized' || view.doc.tokens === undefined) throw this.authRequired(view)
    if (this.usable(view) !== undefined) return
    const op = new Operation('refresh', view.epoch, {
      discovery: view.discovery,
      clientInformation: view.doc.clientInformation,
      tokens: view.doc.tokens,
    }, this.revocations)
    this.current = op
    try {
      if (view.doc.tokens.refresh_token === undefined) {
        await this.commitInvalidation(op, 'tokens')
        throw new McpOAuthError('the access token expired and the grant carries no refresh token', 'AUTH_REQUIRED')
      }
      await this.protocol(() => sdkAuth(this.providerFor(op), { serverUrl: this.spec.serverUrl, fetchFn: this.boundedFetch(op) }))
    } catch (error) {
      throw op.settle(error)
    } finally {
      this.current = undefined
    }
  }

  /** A grant the server still rejects after a fresh refresh is invalidated, so consumers stop retrying it. */
  private rejectGrant(epoch: number): Promise<void> {
    return this.enqueue(async () => {
      this.assertLive()
      const view = await this.readView()
      if (view.kind !== 'grant' || view.epoch !== epoch || view.doc.status !== 'authorized') return
      const op = new Operation('refresh', epoch, { discovery: view.discovery, clientInformation: view.doc.clientInformation }, this.revocations)
      await this.commitInvalidation(op, 'tokens')
    })
  }

  private async revokeRemotely(doc: GrantDocument, tokens: OAuthTokens): Promise<McpOAuthRevocation['remote']> {
    const metadata = doc.discovery?.authorizationServerMetadata
    const endpoint = metadata !== undefined && 'revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined
    const client = doc.clientInformation
    if (metadata === undefined || endpoint === undefined || client === undefined) return 'unsupported'
    const params = new URLSearchParams(tokens.refresh_token === undefined
      ? { token: tokens.access_token, token_type_hint: 'access_token' }
      : { token: tokens.refresh_token, token_type_hint: 'refresh_token' })
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
    const supported = ('revocation_endpoint_auth_methods_supported' in metadata ? metadata.revocation_endpoint_auth_methods_supported : undefined)
      ?? metadata.token_endpoint_auth_methods_supported ?? []
    // The SDK selects a secret-bearing method only for a client that holds a secret.
    const method = selectClientAuthMethod(client, supported)
    if (client.client_secret !== undefined && method === 'client_secret_basic') {
      headers.set('authorization', `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`)
    } else {
      params.set('client_id', client.client_id)
      if (client.client_secret !== undefined && method === 'client_secret_post') params.set('client_secret', client.client_secret)
    }
    try {
      const response = await createBoundedFetch(this.external, this.spec, this.lifecycle.signal, noop)(endpoint, { method: 'POST', headers, body: params })
      await response.body?.cancel().catch(noop)
      return response.ok ? 'succeeded' : 'failed'
    } catch {
      // Any failure — network, bound, abort — leaves the remote token possibly alive; the local tombstone already stands.
      return 'failed'
    }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run)
    this.queue = result.then(noop, noop)
    return result
  }

  private async readView(): Promise<GrantView> {
    return viewGrantRecord(await this.store.readRecord(this.spec.key), this.spec)
  }

  private expiresAt(doc: GrantDocument): number | undefined {
    if (doc.tokens?.expires_in === undefined || doc.tokensIssuedAt === undefined) return undefined
    return doc.tokensIssuedAt + doc.tokens.expires_in * 1000
  }

  private authRequired(view: GrantView): McpOAuthError {
    switch (view.kind) {
      case 'none': return new McpOAuthError('no grant is stored for this MCP server', 'AUTH_REQUIRED')
      case 'invalid': return new McpOAuthError('the stored grant record is invalid', 'AUTH_REQUIRED')
      case 'foreign': return new McpOAuthError('the stored grant was issued for different settings', 'AUTH_REQUIRED')
      case 'grant': return view.doc.status === 'revoked'
        ? new McpOAuthError('the grant was revoked', 'AUTH_REQUIRED')
        : new McpOAuthError('the authorization server rejected the stored grant', 'AUTH_REQUIRED')
    }
  }

  private rotateGrant(reason: McpOAuthError): void {
    const previous = this.grant
    this.grant = new AbortController()
    previous.abort(reason)
  }

  private assertLive(): void {
    if (this.disposed) throw new McpOAuthError('the MCP OAuth engine was disposed', 'DISPOSED')
  }

  private assertNotRevoked(): void {
    if (this.locallyRevoked) throw new McpOAuthError('the grant was revoked', 'AUTH_REQUIRED')
  }

  /** Refuse an authorization that entered before a revocation was latched: only one entered afterwards recovers from it. */
  private assertNotRevokedSince(entered: number): void {
    if (this.revocations !== entered) throw new McpOAuthError('the grant was revoked after this authorization attempt began', 'AUTH_REQUIRED')
  }

  private emit(event: McpOAuthChangeEvent): void {
    try {
      this.onChange?.(event)
    } catch {
      // An observer that throws is contained: the transition it was told about already committed.
    }
  }
}

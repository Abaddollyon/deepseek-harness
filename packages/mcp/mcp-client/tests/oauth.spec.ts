/**
 * MCP OAuth engine behavior against the real MCP SDK `auth()` orchestration
 * and Streamable HTTP client transport. The network is an in-memory fake
 * fetch beneath the engine's production validation and bounds: an OAuth
 * authorization server on one origin and an MCP resource on another.
 */

import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { McpOAuthConnection, McpOAuthError, isMcpOAuthError, resolveMcpOAuthSpec } from '../src/oauth.ts'
import type { McpOAuthChange, McpOAuthChangeEvent, McpOAuthCredentialStore, McpOAuthSpec } from '../src/oauth.ts'
import { createBoundedFetch } from '../src/oauth-fetch.ts'
import { validateDiscovery, viewGrantRecord } from '../src/oauth-record.ts'
import { Fixture, nextSequence } from './oauth-fixture.ts'
import type { FixtureOptions } from './oauth-fixture.ts'

const ISSUER = 'https://issuer.example.test'
const SERVER = 'https://mcp.example.test/mcp'
const REDIRECT = 'https://client.example.test/oauth/callback'
const KEY = 'mcp-client/example' as CredentialKey


interface StoreWrite { sequence: number; payload: unknown }

/** In-memory credential store with the seam's serialized modify contract. */
interface MemoryStore extends McpOAuthCredentialStore {
  writes: StoreWrite[]
  current: () => CredentialRecord | undefined
}

function memoryStore(initial?: CredentialRecord): MemoryStore {
  let current = initial
  let chain: Promise<unknown> = Promise.resolve()
  const writes: StoreWrite[] = []
  return {
    writes,
    current: () => current,
    async readRecord() { return current === undefined ? undefined : structuredClone(current) },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(current === undefined ? undefined : structuredClone(current))
        if (next !== undefined) {
          current = structuredClone(next)
          writes.push({ sequence: nextSequence(), payload: current.kind === 'grant' ? current.payload : current })
        }
        return current
      })
      chain = run.then(() => {}, () => {})
      return run
    },
  }
}

function spec(overrides: Partial<McpOAuthSpec> = {}): McpOAuthSpec {
  return {
    key: KEY,
    serverUrl: SERVER,
    expectedIssuerUrl: ISSUER,
    resourceUrl: SERVER,
    redirectUri: REDIRECT,
    scopes: ['tools:read'],
    clientName: 'DeepSeek Harness test',
    requestTimeoutMs: 500,
    responseByteLimit: 4096,
    refreshLeewayMs: 60_000,
    ...overrides,
  }
}

interface Surface {
  session: AuthorizationSession
  notices: Array<{ message: string; url?: string }>
  prompts: Array<{ kind: string; message: string }>
  controller: AbortController
}

/** An authorization surface that approves through the fixture unless told to answer otherwise. */
function surface(fixture: Fixture, answer?: (authorizationUrl: string) => string | Promise<string>): Surface {
  const notices: Surface['notices'] = []
  const prompts: Surface['prompts'] = []
  const controller = new AbortController()
  return {
    notices,
    prompts,
    controller,
    session: {
      method: 'oauth',
      signal: controller.signal,
      notify(notice) { notices.push(notice) },
      async prompt(prompt) {
        prompts.push({ kind: prompt.kind, message: prompt.message })
        const url = notices.find(notice => notice.url !== undefined)?.url
        if (url === undefined) throw new Error('prompted before any authorization URL was announced')
        return answer === undefined ? fixture.approve(url) : answer(url)
      },
    },
  }
}

interface Harness {
  fixture: Fixture
  store: MemoryStore
  changes: McpOAuthChange[]
  events: McpOAuthChangeEvent[]
  connection: McpOAuthConnection
  clock: { now: number }
}

function harness(options: FixtureOptions = {}, specOverrides: Partial<McpOAuthSpec> = {}, initial?: CredentialRecord): Harness {
  const fixture = new Fixture(options, { server: SERVER, issuer: ISSUER })
  const store = memoryStore(initial)
  const changes: McpOAuthChange[] = []
  const events: McpOAuthChangeEvent[] = []
  const clock = { now: 1_700_000_000_000 }
  const connection = new McpOAuthConnection(store, spec(specOverrides), {
    fetch: fixture.fetch,
    now: () => clock.now,
    onChange: (event) => { changes.push(event.kind); events.push(event) },
  })
  return { fixture, store, changes, events, connection, clock }
}

/** Authorize through the real SDK flow and return the harness ready for managed requests. */
async function authorized(
  options: FixtureOptions = {},
  specOverrides: Partial<McpOAuthSpec> = {},
): Promise<Harness & { surface: Surface }> {
  const h = harness(options, specOverrides)
  const s = surface(h.fixture)
  await h.connection.authorize(s.session)
  return { ...h, surface: s }
}

function grantPayload(store: MemoryStore): Record<string, unknown> {
  const record = store.current()
  if (record?.kind !== 'grant') throw new Error('no grant record stored')
  return record.payload as Record<string, unknown>
}

function tokensOf(store: MemoryStore): { access_token: string; refresh_token?: string } | undefined {
  return grantPayload(store)['tokens'] as { access_token: string; refresh_token?: string } | undefined
}

async function rejects(work: Promise<unknown>, code: string): Promise<Error> {
  try {
    await work
  } catch (error) {
    expect(isMcpOAuthError(error), `expected McpOAuthError ${code}, got ${String(error)}`).toBe(true)
    expect((error as { code: string }).code).toBe(code)
    return error as Error
  }
  throw new Error(`expected rejection with ${code}`)
}

const SECRET = /access-secret|refresh-secret|code-\d|code_verifier|leaked/

describe('resolveMcpOAuthSpec', () => {
  it('fails closed on non-HTTPS identity, issuer query, uncovered server, and bad redirect URIs', () => {
    const store = memoryStore()
    const build = (overrides: Partial<McpOAuthSpec>): (() => McpOAuthConnection) => () => new McpOAuthConnection(store, spec(overrides))
    expect(build({ serverUrl: 'http://mcp.example.test/mcp' })).toThrow('https')
    expect(build({ expectedIssuerUrl: `${ISSUER}/?tenant=1` })).toThrow('query')
    expect(build({ resourceUrl: 'https://mcp.example.test/other' })).toThrow('lie under')
    expect(build({ redirectUri: 'http://client.example.test/callback' })).toThrow('loopback')
    expect(build({ redirectUri: `${REDIRECT}#frag` })).toThrow('fragment')
    expect(build({ redirectUri: `${REDIRECT}?x=1` })).toThrow('query')
    expect(build({ requestTimeoutMs: 0 })).toThrow('requestTimeoutMs')
    expect(build({ responseByteLimit: 1.5 })).toThrow('responseByteLimit')
    expect(build({ clientId: '' })).toThrow('clientId')
    expect(build({ scopes: ['a b'] })).toThrow('scopes')
  })

  it('accepts a loopback HTTP redirect and an HTTPS redirect on an origin unrelated to the issuer', () => {
    const store = memoryStore()
    expect(new McpOAuthConnection(store, spec({ redirectUri: 'http://127.0.0.1:53692/callback' })).spec.redirectUri.href).toBe('http://127.0.0.1:53692/callback')
    expect(new McpOAuthConnection(store, spec()).spec.redirectUri.origin).not.toBe(ISSUER)
  })
})

describe('explicit authorization through the SDK', () => {
  it('discovers, registers, redirects with PKCE S256, exchanges the pasted callback, and commits one durable grant', async () => {
    const h = harness()
    const s = surface(h.fixture)
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'auth-required', reason: 'no-grant' })
    await h.connection.authorize(s.session)

    expect(s.notices).toHaveLength(1)
    const authorization = new URL(s.notices[0]?.url ?? '')
    expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(authorization.searchParams.get('resource')).toBe(SERVER)
    expect(authorization.searchParams.get('scope')).toBe('tools:read')
    expect(authorization.searchParams.get('client_id')).toBe('dcr-client')
    expect(authorization.searchParams.get('state')?.length).toBeGreaterThanOrEqual(32)
    expect(s.prompts).toHaveLength(1)
    expect(s.prompts[0]).toMatchObject({ kind: 'secret' })
    expect(s.prompts[0]?.message).toContain('paste the complete URL')

    expect(h.fixture.calledPaths().filter(path => path.startsWith('POST'))).toEqual(['POST /register', 'POST /token'])
    expect(h.store.writes).toHaveLength(1)
    const payload = grantPayload(h.store)
    expect(payload).toMatchObject({ format: 1, status: 'authorized', epoch: 1, binding: { serverUrl: SERVER, issuerUrl: `${ISSUER}/`, redirectUri: REDIRECT, scopes: ['tools:read'] } })
    expect(tokensOf(h.store)).toEqual({ access_token: 'access-secret-2', token_type: 'Bearer', expires_in: 3600, scope: 'tools:read', refresh_token: 'refresh-secret-2' })
    expect(h.changes).toEqual(['authorized'])

    const status = await h.connection.status()
    expect(status).toEqual({ state: 'authorized', inFlight: undefined, hasRefreshToken: true, accessTokenExpiresAt: h.clock.now + 3_600_000, grantedScope: 'tools:read', epoch: 1 })
    expect(JSON.stringify(status)).not.toMatch(SECRET)
    expect(JSON.stringify(s.notices)).not.toMatch(SECRET)
  })

  it('uses a pre-registered public client id without dynamic registration', async () => {
    const h = await authorized({}, { clientId: 'public-client' })
    expect(h.fixture.calledPaths()).not.toContain('POST /register')
    expect(new URL(h.surface.notices[0]?.url ?? '').searchParams.get('client_id')).toBe('public-client')
    expect(grantPayload(h.store)).toMatchObject({ binding: { clientId: 'public-client' }, clientInformation: { client_id: 'public-client' } })
  })

  it('rejects discovery naming another authorization server before any registration or token request', async () => {
    const h = harness({ prmIssuer: 'https://evil.example.test' })
    const s = surface(h.fixture)
    const error = await rejects(h.connection.authorize(s.session), 'ENDPOINT_NOT_ALLOWED')
    expect(error.message).toContain('https://evil.example.test')
    expect(h.fixture.calledPaths().filter(path => path.startsWith('POST'))).toEqual([])
    expect(h.fixture.calls.every(call => call.url.origin !== 'https://evil.example.test')).toBe(true)
    expect(s.notices).toEqual([])
    expect(h.store.writes).toEqual([])
  })

  it('rejects metadata endpoints outside the issuer origin and a resource that is not the configured one', async () => {
    const endpoints = harness({ endpointOrigin: 'https://other.example.test' })
    await rejects(endpoints.connection.authorize(surface(endpoints.fixture).session), 'DISCOVERY_REJECTED')
    expect(endpoints.fixture.calls.every(call => call.url.origin !== 'https://other.example.test')).toBe(true)
    const resource = harness({ prmResource: 'https://mcp.example.test/other' })
    await rejects(resource.connection.authorize(surface(resource.fixture).session), 'DISCOVERY_REJECTED')
    expect(resource.fixture.calledPaths()).not.toContain('POST /register')
  })

  it.each([
    ['another origin', (fixture: Fixture, url: string) => fixture.approve(url).replace('https://client.example.test', 'https://evil.example.test')],
    ['another path', (fixture: Fixture, url: string) => fixture.approve(url).replace('/oauth/callback', '/oauth/other')],
    ['a wrong state', (fixture: Fixture, url: string) => fixture.approve(url, { state: 'forged' })],
    ['no code', (fixture: Fixture, url: string) => fixture.approve(url, { code: undefined })],
    ['two codes', (fixture: Fixture, url: string) => `${fixture.approve(url)}&code=second`],
    ['an error', (fixture: Fixture, url: string) => fixture.approve(url, { error: 'access_denied' })],
    ['not a URL', () => 'not a url'],
  ])('rejects a callback with %s without exchanging anything', async (_label, answer) => {
    const h = harness()
    const s = surface(h.fixture, url => answer(h.fixture, url))
    const error = await rejects(h.connection.authorize(s.session), 'CALLBACK_INVALID')
    expect(error.message).not.toMatch(SECRET)
    expect(h.fixture.calledPaths()).not.toContain('POST /token')
    expect(h.store.writes).toEqual([])
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'auth-required', reason: 'no-grant', inFlight: undefined })
  })

  it('requires the iss parameter to match when the server advertises it, and rejects a foreign iss anywhere', async () => {
    const missing = harness({ iss: true })
    await rejects(missing.connection.authorize(surface(missing.fixture, url => missing.fixture.approve(url, { iss: undefined })).session), 'CALLBACK_INVALID')
    const wrong = harness({ iss: true })
    await rejects(wrong.connection.authorize(surface(wrong.fixture, url => wrong.fixture.approve(url, { iss: 'https://evil.example.test' })).session), 'CALLBACK_INVALID')
    const unadvertised = harness()
    await rejects(unadvertised.connection.authorize(surface(unadvertised.fixture, url => unadvertised.fixture.approve(url, { iss: 'https://evil.example.test' })).session), 'CALLBACK_INVALID')
    const matching = await authorized({ iss: true })
    expect(tokensOf(matching.store)?.access_token).toBe('access-secret-2')
  })

  it('refuses a second concurrent attempt and a pre-cancelled session', async () => {
    const h = harness()
    const release = h.fixture.hold('/register')
    const first = h.connection.authorize(surface(h.fixture).session)
    await rejects(h.connection.authorize(surface(h.fixture).session), 'ALREADY_IN_FLIGHT')
    release()
    await first
    expect(await h.connection.status()).toMatchObject({ state: 'authorized' })
    const cancelled = surface(h.fixture)
    cancelled.controller.abort()
    await rejects(h.connection.authorize(cancelled.session), 'CANCELLED')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
  })

  it('cancels at the prompt without writing, then authorizes again', async () => {
    const h = harness()
    const s = surface(h.fixture, () => new Promise<string>(() => {}))
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(s.prompts).toHaveLength(1)
    expect(await h.connection.status()).toMatchObject({ state: 'auth-required', inFlight: 'authorize' })
    s.controller.abort(new Error('user closed the page'))
    await rejects(attempt, 'CANCELLED')
    expect(h.store.writes).toEqual([])
    await h.connection.authorize(surface(h.fixture).session)
    expect(await h.connection.status()).toMatchObject({ state: 'authorized' })
  })
})

describe('managed fetch and refresh through the SDK', () => {
  it('attaches the bearer token only to the configured server and refuses caller credential headers', async () => {
    const h = await authorized()
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    const response = await managed(SERVER, { method: 'POST', body: '{}' })
    expect(await response.json()).toEqual({ ok: true, token: 'access-secret-2' })
    const before = h.fixture.calls.length
    for (const target of [
      'https://evil.example.test/mcp',
      'https://mcp.example.test/sibling',
      'https://mcp.example.test/mcp-evil',
      'https://mcp.example.test/mcp/child',
      'https://mcp.example.test/mcp?tenant=other',
      'https://user:pw@mcp.example.test/mcp',
      'http://mcp.example.test/mcp',
    ]) {
      await rejects(managed(target), 'ENDPOINT_NOT_ALLOWED')
    }
    await rejects(managed(SERVER, { headers: { Authorization: 'Bearer mine' } }), 'MANAGED_HEADER')
    await rejects(managed(SERVER, { headers: { cookie: 'session=1' } }), 'MANAGED_HEADER')
    expect(h.fixture.calls.length).toBe(before)
  })

  it('forwards the token only to the endpoint even when the resource audience is a whole origin', async () => {
    const h = await authorized({ prmResource: 'https://mcp.example.test/' }, { resourceUrl: 'https://mcp.example.test/' })
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    expect((await managed(SERVER)).status).toBe(200)
    await rejects(managed('https://mcp.example.test/sibling'), 'ENDPOINT_NOT_ALLOWED')
    expect(h.fixture.calls.filter(call => call.url.pathname === '/sibling')).toEqual([])
  })

  it('returns non-401 failures untouched, wraps request failures with a sanitized cause, and never retries them', async () => {
    const h = await authorized()
    h.fixture.mcp = async () => new Response('boom', { status: 500 })
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    expect((await managed(SERVER)).status).toBe(500)
    h.fixture.mcp = () => { throw new TypeError('socket hang up leaked access-secret-x') }
    const error = await rejects(managed(SERVER), 'NETWORK')
    expect(inspect(error, { depth: 8 })).not.toMatch(SECRET)
    expect(error.cause).toMatchObject({ message: 'failure without a recognized code' })
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
    expect(h.fixture.calls.filter(call => call.url.pathname === '/mcp')).toHaveLength(2)
  })

  it('sends nothing when the consumer or the grant goes away between token acquisition and the request', async () => {
    const h = await authorized()
    const gate = Promise.withResolvers<undefined>()
    const reading = h.store.readRecord.bind(h.store)
    h.store.readRecord = async (key) => { await gate.promise; return reading(key) }
    const consumer = new AbortController()
    const request = h.connection.authenticatedFetch(consumer.signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 5))
    consumer.abort(new Error('consumer gone'))
    gate.resolve(undefined)
    const error = await rejects(request, 'NETWORK')
    expect(error.cause).toMatchObject({ message: 'failure without a recognized code' })
    expect(h.fixture.calls.filter(call => call.url.pathname === '/mcp')).toHaveLength(0)

    const revoked = await authorized()
    const hold = Promise.withResolvers<undefined>()
    const read = revoked.store.readRecord.bind(revoked.store)
    revoked.store.readRecord = async (key) => { await hold.promise; return read(key) }
    const attempt = revoked.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 5))
    revoked.store.readRecord = read
    const revocation = revoked.connection.revoke()
    hold.resolve(undefined)
    await rejects(attempt, 'AUTH_REQUIRED')
    await revocation
    expect(revoked.fixture.calls.filter(call => call.url.pathname === '/mcp')).toHaveLength(0)
  })

  it('surfaces a revocation that lands while the request is on the wire as the revocation, not as a network failure', async () => {
    const h = await authorized()
    const release = h.fixture.hold('/mcp', true)
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 5))
    const revocation = h.connection.revoke()
    const error = await rejects(request, 'AUTH_REQUIRED')
    expect(error.message).toContain('revoked')
    await revocation
    release()
  })

  it('refreshes once for concurrent consumers when the token is expiring, persisting the rotated refresh token', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000 - 30_000
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    const responses = await Promise.all([managed(SERVER), managed(SERVER), managed(SERVER)])
    for (const response of responses) expect(await response.json()).toEqual({ ok: true, token: 'access-secret-3' })
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(2)
    expect(tokensOf(h.store)).toMatchObject({ access_token: 'access-secret-3', refresh_token: 'refresh-secret-3' })
    expect(grantPayload(h.store)['epoch']).toBe(2)
    expect(h.changes).toEqual(['authorized', 'refreshed'])
  })

  it('keeps the previous refresh token when the server omits one', async () => {
    const h = await authorized({ refresh: 'omit' })
    h.clock.now += 3_600_000
    await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
    expect(tokensOf(h.store)).toMatchObject({ access_token: 'access-secret-3', refresh_token: 'refresh-secret-2' })
  })

  it('reports each commit with its epoch and effective scope, inheriting an omitted scope from the grant', async () => {
    const h = await authorized({ scopeInResponse: 'omit' }, { scopes: ['tools:read', 'tools:write'] })
    expect(h.events).toEqual([{ kind: 'authorized', epoch: 1, grantedScope: 'tools:read tools:write' }])
    expect(tokensOf(h.store)).toMatchObject({ scope: 'tools:read tools:write' })
    h.clock.now += 3_600_000
    await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
    expect(h.events[1]).toEqual({ kind: 'refreshed', epoch: 2, grantedScope: 'tools:read tools:write' })
    await expect(h.connection.status()).resolves.toMatchObject({ grantedScope: 'tools:read tools:write', epoch: 2 })
    h.fixture.options.scopeInResponse = 'tools:read'
    h.clock.now += 3_600_000
    await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
    expect(h.events[2]).toEqual({ kind: 'refreshed', epoch: 3, grantedScope: 'tools:read' })
    await expect(h.connection.status()).resolves.toMatchObject({ grantedScope: 'tools:read', epoch: 3 })
    const empty = await authorized({ scopeInResponse: 'omit' }, { scopes: [] })
    expect(empty.events[0]).toEqual({ kind: 'authorized', epoch: 1, grantedScope: undefined })
  })

  it('recognizes its own record writes and nothing else', async () => {
    const h = harness()
    expect(h.connection.ownsRecord(undefined)).toBe(false)
    const s = surface(h.fixture)
    const seen: boolean[] = []
    const store = h.store
    const original = store.modifyRecord.bind(store)
    store.modifyRecord = (key, mutate) => original(key, async (current) => {
      const next = await mutate(current)
      // The store's record-updated observer runs right here, before the engine's commit resolves.
      seen.push(h.connection.ownsRecord(next))
      return next
    })
    await h.connection.authorize(s.session)
    expect(seen).toEqual([true])
    expect(h.connection.ownsRecord(store.current())).toBe(true)
    const foreign = structuredClone(store.current()) as { payload: { epoch: number } }
    foreign.payload.epoch = 99
    expect(h.connection.ownsRecord(foreign as never)).toBe(false)
    expect(h.connection.ownsRecord({ kind: 'grant', payload: 'corrupt' })).toBe(false)
    await h.connection.revoke()
    expect(h.connection.ownsRecord(store.current())).toBe(true)
    expect(h.events.at(-1)).toEqual({ kind: 'revoked', epoch: undefined, grantedScope: undefined })
    expect(grantPayload(store)).toMatchObject({ status: 'revoked', epoch: 2 })
    const other = harness({}, {}, store.current())
    expect(other.connection.ownsRecord(store.current())).toBe(false)
  })

  it('vouches only for exactly the record it last stored: not a same-epoch alteration, not an older own record', async () => {
    const h = await authorized()
    const first = structuredClone(h.store.current())
    h.clock.now += 3_600_000
    await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
    const second = structuredClone(h.store.current()) as { kind: 'grant'; payload: Record<string, unknown> }
    expect(second.payload['epoch']).toBe(2)
    expect(h.connection.ownsRecord(second)).toBe(true)
    // Key order is not identity: the same document reordered still reads as own.
    const reordered = { kind: 'grant' as const, payload: Object.fromEntries(Object.entries(second.payload).reverse()) }
    expect(h.connection.ownsRecord(reordered)).toBe(true)
    // The same epoch with anything else changed is somebody else's write.
    const tombstoned = { kind: 'grant' as const, payload: { ...second.payload, status: 'revoked', tokens: undefined, tokensIssuedAt: undefined } }
    expect(h.connection.ownsRecord(tombstoned)).toBe(false)
    const rescoped = structuredClone(second)
    ;(rescoped.payload['tokens'] as { scope: string }).scope = 'tools:read tools:write'
    expect(h.connection.ownsRecord(rescoped)).toBe(false)
    // An older record this engine once wrote, put back by someone else, is external.
    expect(h.connection.ownsRecord(first)).toBe(false)
    // A write the store rejected is not vouched for afterwards.
    const working = h.store.modifyRecord.bind(h.store)
    h.store.modifyRecord = async (key, mutate) => {
      await working(key, mutate)
      throw new Error('disk full after write')
    }
    h.clock.now += 3_600_000
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'REFRESH_FAILED')
    h.store.modifyRecord = working
    expect(h.connection.ownsRecord(h.store.current())).toBe(false)
    expect(h.connection.ownsRecord(second)).toBe(true)
    // A captured classifier keeps the identities of its instant: a later own write is not in it, its own is.
    const captured = h.connection.captureOwnership()
    h.clock.now += 3_600_000
    await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
    expect(captured(h.store.current())).toBe(false)
    expect(captured(second)).toBe(true)
    expect(h.connection.ownsRecord(h.store.current())).toBe(true)
  })

  it('answers a 401 with one shared forced refresh and one retry per request', async () => {
    const h = await authorized()
    h.fixture.accessTokens.clear()
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    const responses = await Promise.all([managed(SERVER, { body: '{"a":1}', method: 'POST' }), managed(SERVER)])
    for (const response of responses) expect(await response.json()).toEqual({ ok: true, token: 'access-secret-3' })
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(2)
    expect(h.fixture.calledPaths().filter(path => path === 'GET /mcp' || path === 'POST /mcp')).toHaveLength(4)
  })

  it('returns a 401 with a streaming body unretried and never opens an authorization flow', async () => {
    const h = await authorized()
    h.fixture.accessTokens.clear()
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close() } })
    const response = await managed(SERVER, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(response.status).toBe(401)
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
    expect(h.surface.notices).toHaveLength(1)
    // The rejection is remembered: the next request refreshes first instead of resending the rejected token.
    expect(await (await managed(SERVER)).json()).toEqual({ ok: true, token: 'access-secret-3' })
    const bearers = h.fixture.calls.filter(call => call.url.pathname === '/mcp').map(call => call.headers.get('authorization'))
    expect(bearers).toEqual(['Bearer access-secret-2', 'Bearer access-secret-3'])
  })

  it('invalidates the grant when the server rejects a freshly refreshed token, then requires authorization', async () => {
    const h = await authorized()
    h.fixture.options.rejectAll = true
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    expect((await managed(SERVER)).status).toBe(401)
    expect(grantPayload(h.store)).toMatchObject({ status: 'invalidated', epoch: 3 })
    expect(tokensOf(h.store)).toBeUndefined()
    expect(h.changes).toEqual(['authorized', 'refreshed', 'invalidated'])
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'auth-required', reason: 'grant-invalidated' })
    await rejects(managed(SERVER), 'AUTH_REQUIRED')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(2)
  })

  it('drops the tokens on invalid_grant without any interactive step, and keeps them on a transient refresh failure', async () => {
    const invalid = await authorized({ refresh: 'invalid_grant' })
    invalid.clock.now += 3_600_000
    await rejects(invalid.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(grantPayload(invalid.store)).toMatchObject({ status: 'invalidated' })
    expect(invalid.surface.notices).toHaveLength(1)
    expect(invalid.surface.prompts).toHaveLength(1)
    expect(invalid.changes).toEqual(['authorized', 'invalidated'])

    const transient = await authorized({ refresh: 'error' })
    transient.clock.now += 3_600_000
    await rejects(transient.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'REFRESH_FAILED')
    expect(tokensOf(transient.store)).toMatchObject({ access_token: 'access-secret-2', refresh_token: 'refresh-secret-2' })
    await expect(transient.connection.status()).resolves.toMatchObject({ state: 'authorized' })
  })

  it('never resends a rejected token after a transient refresh failure; the next call refreshes again', async () => {
    const h = await authorized({ refresh: 'error' })
    h.fixture.accessTokens.clear()
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    await rejects(managed(SERVER), 'REFRESH_FAILED')
    await rejects(managed(SERVER), 'REFRESH_FAILED')
    h.fixture.options.refresh = 'rotate'
    expect(await (await managed(SERVER)).json()).toEqual({ ok: true, token: 'access-secret-3' })
    const bearers = h.fixture.calls.filter(call => call.url.pathname === '/mcp').map(call => call.headers.get('authorization'))
    expect(bearers).toEqual(['Bearer access-secret-2', 'Bearer access-secret-3'])
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(4)
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'authorized' })
  })

  it('does not let a 401 during an explicit attempt open a second interactive flow; the refresh waits its turn', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const s = surface(h.fixture, () => new Promise<string>(() => {}))
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 20))
    let settled = false
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER).finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(s.notices).toHaveLength(1)
    expect(s.prompts).toHaveLength(1)
    s.controller.abort()
    await rejects(attempt, 'CANCELLED')
    expect(await (await request).json()).toEqual({ ok: true, token: 'access-secret-3' })
    expect(s.notices).toHaveLength(1)
  })

  it('releases a consumer that aborts while waiting for the shared refresh, which still completes under engine bounds', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const release = h.fixture.hold('/token')
    const consumer = new AbortController()
    const waiting = h.connection.authenticatedFetch(consumer.signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    consumer.abort(new Error('consumer gone'))
    await expect(waiting).rejects.toThrow('consumer gone')
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(tokensOf(h.store)?.access_token).toBe('access-secret-3')
  })
})

describe('revocation, disposal, and stale commits', () => {
  it('revokes locally first, aborts consumers synchronously, then reports the bounded remote attempt', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const release = h.fixture.hold('/token')
    const consumer = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    const revocation = h.connection.revoke()
    await rejects(consumer, 'AUTH_REQUIRED')
    await expect(revocation).resolves.toEqual({ local: 'revoked', remote: 'succeeded' })
    const tombstone = h.store.writes.at(-1)
    const remote = h.fixture.calls.find(call => call.url.pathname === '/revoke')
    expect(tombstone?.sequence).toBeLessThan(remote?.sequence ?? 0)
    expect(remote?.body).toContain('token=refresh-secret-2')
    expect(grantPayload(h.store)).toMatchObject({ status: 'revoked', epoch: 2 })
    expect(tokensOf(h.store)).toBeUndefined()
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })

    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked', inFlight: undefined })
    expect(grantPayload(h.store)).toMatchObject({ status: 'revoked', epoch: 2 })
    expect(h.store.writes).toHaveLength(2)
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(2)
    expect(h.changes).toEqual(['authorized', 'revoked'])
  })

  it('refuses every new request from the first synchronous step of revocation, even while the tombstone write is held', async () => {
    const h = await authorized()
    const gate = Promise.withResolvers<undefined>()
    const working = h.store.modifyRecord.bind(h.store)
    h.store.modifyRecord = async (key, mutate) => { await gate.promise; return working(key, mutate) }
    const revocation = h.connection.revoke()
    expect(h.events.at(-1)).toEqual({ kind: 'revoked', epoch: undefined, grantedScope: undefined })
    const requests = h.fixture.calls.length
    h.clock.now += 3_600_000
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    h.clock.now -= 3_600_000
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(h.fixture.calls.length).toBe(requests)
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })
    gate.resolve(undefined)
    await expect(revocation).resolves.toEqual({ local: 'revoked', remote: 'succeeded' })
    expect(grantPayload(h.store)).toMatchObject({ status: 'revoked' })
    // Revoking again re-tombstones without telling consumers twice.
    await expect(h.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'no-grant' })
    expect(h.events.filter(event => event.kind === 'revoked')).toHaveLength(1)
    // A fresh engine over the stored tombstone (a Host restart) reads the durable revocation itself.
    const restarted = harness({}, {}, h.store.current())
    await expect(restarted.connection.status()).resolves.toMatchObject({ state: 'revoked', epoch: 3 })
    const refused = await rejects(restarted.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(refused.message).toContain('revoked')
  })

  it('stays locally revoked when the tombstone write fails, reports that truthfully, and recovers only through an explicit re-authorization', async () => {
    const h = await authorized()
    const working = h.store.modifyRecord.bind(h.store)
    h.store.modifyRecord = () => Promise.reject(new Error('store offline leaked access-secret'))
    const error = await rejects(h.connection.revoke(), 'STORE')
    expect(inspect(error, { depth: 8 })).not.toMatch(SECRET)
    h.store.modifyRecord = () => Promise.resolve(undefined)
    await rejects(h.connection.revoke(), 'PROTOCOL')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /revoke')).toEqual([])
    expect(grantPayload(h.store)).toMatchObject({ status: 'authorized' })
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked', epoch: undefined })
    const requests = h.fixture.calls.length
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(h.fixture.calls.length).toBe(requests)
    h.store.modifyRecord = working
    await h.connection.authorize(surface(h.fixture).session)
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'authorized', epoch: 2 })
    expect(await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).json()).toMatchObject({ ok: true })
  })

  it('does not let an authorization aborted between mutation and acknowledgement clear the latch or report a grant', async () => {
    const h = await authorized()
    const working = h.store.modifyRecord.bind(h.store)
    const acknowledge = Promise.withResolvers<undefined>()
    let calls = 0
    h.store.modifyRecord = async (key, mutate) => {
      calls += 1
      // First write (the authorization commit): mutated and stored, acknowledgement withheld.
      if (calls === 1) {
        const result = await working(key, mutate)
        await acknowledge.promise
        return result
      }
      // Second write (the revocation tombstone): the store fails.
      return Promise.reject(new Error('store offline'))
    }
    const events = h.events.length
    const attempt = h.connection.authorize(surface(h.fixture).session)
    await vi.waitFor(() => { expect(calls).toBe(1) })
    await rejects(h.connection.revoke(), 'STORE')
    acknowledge.resolve(undefined)
    await rejects(attempt, 'AUTH_REQUIRED')
    expect(h.events.slice(events).map(event => event.kind)).toEqual(['revoked'])
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })
    h.store.modifyRecord = working
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
  })

  it('refuses an authorization that entered before the revocation but had not started when it was latched', async () => {
    const h = await authorized()
    const reading = Promise.withResolvers<undefined>()
    const read = h.store.readRecord.bind(h.store)
    h.store.readRecord = async (key) => { await reading.promise; return read(key) }
    const working = h.store.modifyRecord.bind(h.store)
    const s = surface(h.fixture)
    const attempt = h.connection.authorize(s.session)
    h.store.modifyRecord = () => Promise.reject(new Error('store offline'))
    await rejects(h.connection.revoke(), 'STORE')
    h.store.readRecord = read
    h.store.modifyRecord = working
    reading.resolve(undefined)
    await rejects(attempt, 'AUTH_REQUIRED')
    expect(s.notices).toEqual([])
    expect(s.prompts).toEqual([])
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    // Control: an authorization entered after the revocation is the explicit recovery and lifts the latch.
    await h.connection.authorize(surface(h.fixture).session)
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'authorized' })
    expect(await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).json()).toMatchObject({ ok: true })
  })

  it('reports STORE without claiming the record unchanged when the store commits and then rejects, and never reaches the remote endpoint', async () => {
    const h = await authorized()
    const working = h.store.modifyRecord.bind(h.store)
    h.store.modifyRecord = async (key, mutate) => {
      await working(key, mutate)
      throw new Error('lock release failed')
    }
    const error = await rejects(h.connection.revoke(), 'STORE')
    expect(error.message).not.toMatch(/still stored|unchanged/)
    expect(grantPayload(h.store)).toMatchObject({ status: 'revoked' })
    expect(h.fixture.calledPaths().filter(path => path === 'POST /revoke')).toEqual([])
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })
  })

  it('does not publish a grant when the revocation lands in any microtask between the store acknowledgement and publication', async () => {
    // The acknowledgement travels through several awaits before the grant is published; the revocation is
    // latched after each possible number of hops, so every gap in that chain is exercised.
    for (let hops = 0; hops < 8; hops += 1) {
      const h = await authorized()
      const working = h.store.modifyRecord.bind(h.store)
      let writes = 0
      h.store.modifyRecord = async (key, mutate) => {
        writes += 1
        if (writes !== 1) return working(key, mutate)
        const result = await working(key, mutate)
        const latch = (): void => {
          h.store.modifyRecord = () => Promise.reject(new Error('store offline'))
          void h.connection.revoke().catch(() => {})
        }
        let schedule = latch
        for (let depth = 0; depth < hops; depth += 1) {
          const inner = schedule
          schedule = () => { queueMicrotask(inner) }
        }
        schedule()
        return result
      }
      const events = h.events.length
      const attempt = h.connection.authorize(surface(h.fixture).session)
      const outcome = await attempt.then(() => 'published', (error: unknown) => (isMcpOAuthError(error, 'AUTH_REQUIRED') ? 'refused' : 'other'))
      const kinds = h.events.slice(events).map(event => event.kind)
      // Landing before publication: nothing published. Landing after: the grant was published first, then
      // revoked — never a grant published on top of a latched revocation.
      if (outcome === 'refused') expect(kinds, `hops=${hops}`).toEqual(['revoked'])
      else expect([outcome, kinds], `hops=${hops}`).toEqual(['published', ['authorized', 'revoked']])
      await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })
      await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
      if (outcome === 'published') break
      expect(hops, 'the acknowledgement-to-publication chain is shorter than the scan').toBeLessThan(7)
    }
  })

  it('reports the local refusal immediately without touching a store whose read never settles', async () => {
    const h = await authorized()
    h.store.modifyRecord = () => Promise.reject(new Error('store offline'))
    await rejects(h.connection.revoke(), 'STORE')
    let reads = 0
    h.store.readRecord = () => { reads += 1; return new Promise(() => {}) }
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked', epoch: undefined })
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(reads).toBe(0)
  })

  it('reports the local refusal even when the store cannot be read', async () => {
    const h = await authorized()
    h.store.modifyRecord = () => Promise.reject(new Error('store offline'))
    await rejects(h.connection.revoke(), 'STORE')
    h.store.readRecord = () => Promise.reject(new Error('store offline'))
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked', epoch: undefined })
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
  })

  it('reports remote revocation truthfully: unsupported, failed, and no grant', async () => {
    const unsupported = await authorized({ revocation: 'none' })
    await expect(unsupported.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'unsupported' })
    const failed = await authorized({ revocation: 'error' })
    await expect(failed.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'failed' })
    expect(grantPayload(failed.store)).toMatchObject({ status: 'revoked' })
    const empty = harness()
    await expect(empty.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'no-grant' })
  })

  it('discards a callback exchange that completes after revocation, even though the fixture ignored the abort', async () => {
    const h = harness()
    const release = h.fixture.hold('/token')
    const attempt = h.connection.authorize(surface(h.fixture).session)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.fixture.calledPaths()).toContain('POST /token')
    await expect(h.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'no-grant' })
    release()
    await rejects(attempt, 'AUTH_REQUIRED')
    expect(grantPayload(h.store)).toMatchObject({ status: 'revoked', epoch: 1 })
    expect(h.store.writes).toHaveLength(1)
  })

  it('disposes: aborts the running exchange, refuses late commits, and reaches quiescence before resolving', async () => {
    const h = harness()
    const release = h.fixture.hold('/token')
    const attempt = h.connection.authorize(surface(h.fixture).session)
    await new Promise(resolve => setTimeout(resolve, 20))
    let disposed = false
    const disposal = h.connection.dispose().then(() => { disposed = true })
    await rejects(attempt, 'DISPOSED')
    await disposal
    expect(disposed).toBe(true)
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.store.writes).toEqual([])
    expect(h.events).toEqual([{ kind: 'disposed', epoch: undefined, grantedScope: undefined }])
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'disposed' })
    await rejects(h.connection.authorize(surface(h.fixture).session), 'DISPOSED')
    await rejects(h.connection.revoke(), 'DISPOSED')
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'DISPOSED')
    await h.connection.dispose()
  })

  it('disposes while a surface ignores the withdrawn prompt', async () => {
    const h = harness()
    const s = surface(h.fixture, () => new Promise<string>(() => {}))
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 20))
    await h.connection.dispose()
    await rejects(attempt, 'DISPOSED')
  })

  it('refuses a stale refresh commit when the record moved underneath the operation', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const release = h.fixture.hold('/token')
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    await h.store.modifyRecord(KEY, async (current) => {
      const payload = (current as { payload: Record<string, unknown> }).payload
      return { kind: 'grant', payload: { ...payload, epoch: 41 } }
    })
    release()
    await rejects(request, 'STALE')
    expect(grantPayload(h.store)['epoch']).toBe(41)
  })
})

describe('bounded protocol responses', () => {
  it.each([
    ['a chunked body without Content-Length', 'chunked-large', 'RESPONSE_BOUND'],
    ['a body larger than its Content-Length', 'lying-length', 'RESPONSE_BOUND'],
    ['a body that stalls past the time bound', 'stalled', 'NETWORK'],
  ] as const)('rejects %s', async (_label, metadataBody, code) => {
    const h = harness({ metadataBody })
    const s = surface(h.fixture)
    await rejects(h.connection.authorize(s.session), code)
    expect(s.notices).toEqual([])
    expect(h.store.writes).toEqual([])
  })

  it('bounds nothing about MCP response bodies handed back through the managed fetch', async () => {
    const h = await authorized()
    h.fixture.mcp = async () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < 8; index += 1) controller.enqueue(new Uint8Array(4096))
        controller.close()
      },
    }))
    const response = await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    expect((await response.arrayBuffer()).byteLength).toBe(8 * 4096)
  })
})

describe('durable record validation', () => {
  it('treats a corrupt record as no grant and never sends anything from it', async () => {
    const h = harness({}, {}, { kind: 'grant', payload: { format: 1, tokens: { access_token: 'access-secret-x', token_type: 'Bearer' } } })
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'auth-required', reason: 'record-invalid' })
    const error = await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(error.message).not.toMatch(SECRET)
    expect(h.fixture.calls).toEqual([])
  })

  it('does not reuse a grant whose scopes, redirect, or client changed, and replaces it on the next authorization', async () => {
    const wide = await authorized({}, { scopes: ['tools:read', 'tools:write'] })
    const record = wide.store.current()
    for (const overrides of [{ scopes: ['tools:read'] }, { redirectUri: 'https://client.example.test/other' }, { clientId: 'public-client' }] as const) {
      const narrowed = harness({}, overrides, record)
      await expect(narrowed.connection.status()).resolves.toMatchObject({ state: 'auth-required', reason: 'binding-changed', epoch: 1 })
      await rejects(narrowed.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
      expect(narrowed.fixture.calls).toEqual([])
    }
    const replaced = harness({}, { scopes: ['tools:read'] }, record)
    await replaced.connection.authorize(surface(replaced.fixture).session)
    expect(grantPayload(replaced.store)).toMatchObject({ epoch: 2, binding: { scopes: ['tools:read'] } })
  })

  it('rejects a stored discovery that no longer satisfies the spec', async () => {
    const h = await authorized()
    const stored = grantPayload(h.store)
    const tampered = structuredClone(stored) as { discovery: { authorizationServerMetadata: { token_endpoint: string } } }
    tampered.discovery.authorizationServerMetadata.token_endpoint = 'https://evil.example.test/token'
    const next = harness({}, {}, { kind: 'grant', payload: tampered })
    await expect(next.connection.status()).resolves.toMatchObject({ state: 'auth-required', reason: 'record-invalid' })
  })
})

describe('real SDK Streamable HTTP transport', () => {
  it('serves tools through the managed fetch, recovering from a server-side token rejection without an auth provider', async () => {
    const h = await authorized()
    // Stateless server: one MCP server and transport per request, as the HTTP fixture does.
    h.fixture.mcp = async (request) => {
      const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' })
      server.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
      const serverTransport = new WebStandardStreamableHTTPServerTransport({})
      await server.connect(serverTransport)
      return serverTransport.handleRequest(request)
    }

    const consumer = new AbortController()
    const transport = new StreamableHTTPClientTransport(new URL(SERVER), { fetch: h.connection.authenticatedFetch(consumer.signal) })
    const client = new Client({ name: 'oauth-test', version: '1.0.0' })
    // Same SDK exactOptionalPropertyTypes widening as the production transport factory.
    await client.connect(transport as Transport)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ping'])

    h.fixture.accessTokens.clear()
    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }])
    expect(tokensOf(h.store)?.access_token).toBe('access-secret-3')
    const bearers = h.fixture.calls.filter(call => call.url.pathname === '/mcp').map(call => call.headers.get('authorization'))
    expect(new Set(bearers)).toEqual(new Set(['Bearer access-secret-2', 'Bearer access-secret-3']))
    expect(h.surface.notices).toHaveLength(1)

    await client.close()
    await h.connection.dispose()
  })
})
describe('server behaviors the SDK surfaces', () => {
  it('requests no scope when none is configured', async () => {
    const h = await authorized({}, { scopes: [] })
    const authorization = new URL(h.surface.notices[0]?.url ?? '')
    expect(authorization.searchParams.has('scope')).toBe(false)
    const registration = JSON.parse(h.fixture.calls.find(call => call.url.pathname === '/register')?.body ?? '{}') as Record<string, unknown>
    expect(registration['scope']).toBeUndefined()
    expect(grantPayload(h.store)).toMatchObject({ binding: { scopes: [] } })
  })

  it('surfaces a registration refusal, a foreign redirect registration, and a network failure with their causes', async () => {
    const refused = harness({ register: 'error' })
    const error = await rejects(refused.connection.authorize(surface(refused.fixture).session), 'PROTOCOL')
    expect(error.cause).toMatchObject({ message: 'OAuth error invalid_client_metadata' })
    expect(inspect(error, { depth: 8 })).not.toMatch(SECRET)
    const garbage = harness({ register: 'garbage' })
    const raw = await rejects(garbage.connection.authorize(surface(garbage.fixture).session), 'PROTOCOL')
    expect(inspect(raw, { depth: 8 })).not.toMatch(SECRET)
    expect(raw.cause).toMatchObject({ message: 'OAuth error server_error' })
    const foreign = harness({ register: 'other-redirect' })
    await rejects(foreign.connection.authorize(surface(foreign.fixture).session), 'DISCOVERY_REJECTED')
    expect(foreign.fixture.calledPaths()).not.toContain('POST /token')
    const network = harness({ throwOn: '/register' })
    const failure = await rejects(network.connection.authorize(surface(network.fixture).session), 'NETWORK')
    expect(failure.cause).toMatchObject({ message: 'failure without a recognized code' })
  })

  it('sends the code once: a rejected exchange is not retried with the consumed verifier', async () => {
    const h = harness({ exchange: 'invalid_grant' })
    const error = await rejects(h.connection.authorize(surface(h.fixture).session), 'PROTOCOL')
    expect(inspect(error, { depth: 8 })).not.toMatch(SECRET)
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
    expect(h.store.writes).toEqual([])
  })

  it('refuses a non-bearer token response', async () => {
    const h = harness({ exchange: 'mac' })
    const error = await rejects(h.connection.authorize(surface(h.fixture).session), 'PROTOCOL')
    expect(error.message).not.toContain('mac-secret')
    expect(h.store.writes).toEqual([])
  })

  it('does not let a server without resource metadata pose as the issuer', async () => {
    const h = harness({ prm: false })
    await rejects(h.connection.authorize(surface(h.fixture).session), 'DISCOVERY_REJECTED')
    expect(h.fixture.calledPaths().filter(path => path.startsWith('POST'))).toEqual([])
  })

  it('rejects a response whose declared length exceeds the byte bound before reading it', async () => {
    const h = harness({ metadataBody: 'declared-large' })
    await rejects(h.connection.authorize(surface(h.fixture).session), 'RESPONSE_BOUND')
  })

  it('cancels between the redirect notice and the prompt, and while discovery is in flight', async () => {
    const atNotice = harness()
    const s = surface(atNotice.fixture)
    const original = s.session.notify.bind(s.session)
    s.session.notify = (notice) => { original(notice); s.controller.abort() }
    await rejects(atNotice.connection.authorize(s.session), 'CANCELLED')
    expect(s.prompts).toEqual([])

    const atDiscovery = harness()
    const release = atDiscovery.fixture.hold('/.well-known/oauth-protected-resource/mcp')
    const waiting = surface(atDiscovery.fixture)
    const attempt = atDiscovery.connection.authorize(waiting.session)
    await new Promise(resolve => setTimeout(resolve, 10))
    waiting.controller.abort()
    await rejects(attempt, 'CANCELLED')
    release()
    expect(atDiscovery.fixture.calledPaths()).not.toContain('POST /register')
  })

  it('authenticates as a confidential client at the token and revocation endpoints', async () => {
    for (const clientAuth of ['client_secret_basic', 'client_secret_post'] as const) {
      const h = await authorized({ clientAuth })
      h.clock.now += 3_600_000
      await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
      expect(tokensOf(h.store)?.access_token).toBe('access-secret-3')
      await expect(h.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'succeeded' })
      expect(JSON.stringify(await h.connection.status())).not.toContain('client-secret')
    }
  })

  it('invalidates the registration too when the token endpoint answers invalid_client', async () => {
    const h = await authorized({ refresh: 'invalid_client' })
    h.clock.now += 3_600_000
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    const payload = grantPayload(h.store)
    expect(payload).toMatchObject({ status: 'invalidated' })
    expect(payload['clientInformation']).toBeUndefined()
    expect(payload['discovery']).toBeUndefined()
  })

  it('invalidates a grant that expired without a refresh token, and revokes an access-only grant by access token', async () => {
    const expired = await authorized({ refreshTokens: false })
    expired.clock.now += 3_600_000
    await rejects(expired.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(grantPayload(expired.store)).toMatchObject({ status: 'invalidated', clientInformation: { client_id: 'dcr-client' } })
    expect(expired.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)

    const accessOnly = await authorized({ refreshTokens: false })
    await expect(accessOnly.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'succeeded' })
    expect(accessOnly.fixture.calls.find(call => call.url.pathname === '/revoke')?.body).toContain('token_type_hint=access_token')
  })

  it('never refreshes by clock when the server advertises no expiry', async () => {
    const h = await authorized({ expiresIn: null })
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'authorized', accessTokenExpiresAt: undefined })
    h.clock.now += 365 * 24 * 3_600_000
    await (await h.connection.authenticatedFetch(new AbortController().signal)(SERVER)).body?.cancel()
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
  })

  it('gives up after the shared refresh twice yields an already-expired token', async () => {
    const h = await authorized({ expiresIn: 0 })
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'REFRESH_FAILED')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(3)
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'authorized' })
  })

  it('reports a remote revocation that fails at the network layer', async () => {
    const h = await authorized({ throwOn: '/revoke' })
    await expect(h.connection.revoke()).resolves.toEqual({ local: 'revoked', remote: 'failed' })
    await expect(h.connection.status()).resolves.toMatchObject({ state: 'revoked' })
  })

  it('keeps the grant when the credential store itself fails a refresh commit', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const working = h.store.modifyRecord.bind(h.store)
    let failNext = true
    h.store.modifyRecord = (key, mutate) => {
      if (!failNext) return working(key, mutate)
      failNext = false
      return Promise.reject(new Error('disk full'))
    }
    await rejects(h.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'REFRESH_FAILED')
    expect(tokensOf(h.store)?.access_token).toBe('access-secret-2')
  })
})

describe('queue ordering around an explicit attempt', () => {
  it('lets a refresh queued behind an authorization reuse the grant that authorization committed', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const gate = Promise.withResolvers<string>()
    const s = surface(h.fixture, () => gate.promise)
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 10))
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.resolve(h.fixture.approve(s.notices[0]?.url ?? ''))
    await attempt
    expect(await (await request).json()).toEqual({ ok: true, token: 'access-secret-4' })
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(2)
    expect(h.changes).toEqual(['authorized', 'authorized'])
  })

  it('refuses a refresh queued behind an authorization once a revocation landed in between', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const s = surface(h.fixture, () => new Promise<string>(() => {}))
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 10))
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(h.connection.revoke()).resolves.toMatchObject({ local: 'revoked' })
    await rejects(attempt, 'AUTH_REQUIRED')
    await rejects(request, 'AUTH_REQUIRED')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
    expect(grantPayload(h.store)).toMatchObject({ status: 'revoked' })
  })

  it('refuses a refresh queued behind an authorization once the record was corrupted in between', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const s = surface(h.fixture, () => new Promise<string>(() => {}))
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 10))
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    await h.store.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: 'corrupt' }))
    s.controller.abort()
    await rejects(attempt, 'CANCELLED')
    const error = await rejects(request, 'AUTH_REQUIRED')
    expect(error.message).toContain('invalid')
    expect(h.fixture.calledPaths().filter(path => path === 'POST /token')).toHaveLength(1)
  })

  it('honors a withdrawal that lands while the attempt waits its turn in the queue', async () => {
    const h = await authorized()
    h.clock.now += 3_600_000
    const release = h.fixture.hold('/token')
    const request = h.connection.authenticatedFetch(new AbortController().signal)(SERVER)
    await new Promise(resolve => setTimeout(resolve, 10))
    const s = surface(h.fixture)
    const attempt = h.connection.authorize(s.session)
    await new Promise(resolve => setTimeout(resolve, 10))
    s.controller.abort()
    release()
    await request
    await rejects(attempt, 'CANCELLED')
    expect(s.notices).toEqual([])
    expect(h.fixture.calledPaths().filter(path => path === 'POST /register')).toHaveLength(1)
  })

  it('rejects immediately for a consumer that is already gone and for an empty store', async () => {
    const empty = harness()
    await rejects(empty.connection.authenticatedFetch(new AbortController().signal)(SERVER), 'AUTH_REQUIRED')
    expect(empty.fixture.calls).toEqual([])
    const h = await authorized()
    h.clock.now += 3_600_000
    const consumer = new AbortController()
    consumer.abort(new Error('gone'))
    await expect(h.connection.authenticatedFetch(consumer.signal)(SERVER)).rejects.toThrow('gone')
  })

  it('invalidates once when two consumers see the same final rejection', async () => {
    const h = await authorized()
    h.fixture.options.rejectAll = true
    const managed = h.connection.authenticatedFetch(new AbortController().signal)
    const [first, second] = await Promise.all([managed(SERVER), managed(SERVER)])
    expect([first.status, second.status]).toEqual([401, 401])
    expect(h.changes).toEqual(['authorized', 'refreshed', 'invalidated'])
    expect(h.store.writes).toHaveLength(3)
  })
})

describe('validation helpers', () => {
  const resolved = resolveMcpOAuthSpec(spec())
  const metadata = (): Record<string, unknown> => ({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  })
  const state = (overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = metadata()): OAuthDiscoveryState =>
    ({ authorizationServerUrl: `${ISSUER}/`, authorizationServerMetadata: meta, ...overrides }) as unknown as OAuthDiscoveryState

  it('accepts discovery matching the spec and normalizes what it keeps', () => {
    expect(validateDiscovery(state(), resolved)).toEqual({ authorizationServerUrl: `${ISSUER}/`, authorizationServerMetadata: metadata() })
    const full = validateDiscovery(state({
      resourceMetadata: { resource: SERVER },
      resourceMetadataUrl: `${new URL(SERVER).origin}/.well-known/oauth-protected-resource/mcp`,
    }), resolved)
    expect(full.resourceMetadata).toEqual({ resource: SERVER })
    expect(full.resourceMetadataUrl).toContain('/.well-known/')
  })

  it.each([
    ['an unparseable authorization server', state({ authorizationServerUrl: 'nope' })],
    ['another authorization server', state({ authorizationServerUrl: 'https://evil.example.test/' })],
    ['no metadata', state({ authorizationServerMetadata: undefined })],
    ['another issuer in metadata', state({}, { ...metadata(), issuer: 'https://evil.example.test' })],
    ['an unparseable endpoint', state({}, { ...metadata(), token_endpoint: 'not a url' })],
    ['an http endpoint', state({}, { ...metadata(), token_endpoint: 'http://issuer.example.test/token' })],
    ['a revocation endpoint elsewhere', state({}, { ...metadata(), revocation_endpoint: 'https://evil.example.test/revoke' })],
    ['no code response type', state({}, { ...metadata(), response_types_supported: ['token'] })],
    ['no PKCE S256', state({}, { ...metadata(), code_challenge_methods_supported: ['plain'] })],
    ['unadvertised PKCE', state({}, { ...metadata(), code_challenge_methods_supported: undefined })],
    ['another resource', state({ resourceMetadata: { resource: 'https://mcp.example.test/other' } })],
    ['an unparseable resource', state({ resourceMetadata: { resource: 'nope' } })],
    ['a resource metadata URL elsewhere', state({ resourceMetadataUrl: 'https://evil.example.test/.well-known/oauth-protected-resource' })],
    ['an unparseable resource metadata URL', state({ resourceMetadataUrl: 'nope' })],
  ])('rejects discovery with %s', (_label, discovery) => {
    expect(() => validateDiscovery(discovery, resolved)).toThrow(expect.objectContaining({ code: 'DISCOVERY_REJECTED' }))
  })

  it('views records: none, non-grant, corrupt, foreign, and a tombstone without discovery', async () => {
    expect(viewGrantRecord(undefined, resolved)).toEqual({ kind: 'none', epoch: undefined })
    expect(viewGrantRecord({ kind: 'api-key', key: 'k' }, resolved)).toEqual({ kind: 'invalid', epoch: undefined })
    expect(viewGrantRecord({ kind: 'grant', payload: 'text' }, resolved)).toEqual({ kind: 'invalid', epoch: undefined })
    const empty = harness()
    await empty.connection.revoke()
    const tombstone = viewGrantRecord(empty.store.current(), resolved)
    expect(tombstone).toMatchObject({ kind: 'grant', epoch: 1, discovery: undefined })
    await expect(empty.connection.status()).resolves.toMatchObject({ state: 'revoked', epoch: undefined })
    const foreign = resolveMcpOAuthSpec(spec({ scopes: [] }))
    expect(viewGrantRecord(empty.store.current(), foreign)).toEqual({ kind: 'foreign', epoch: 1 })
  })

  it('rejects spec URLs carrying credentials, a resource fragment, an unparseable value, or an empty client name', () => {
    const store = memoryStore()
    expect(() => new McpOAuthConnection(store, spec({ serverUrl: 'https://user:pw@mcp.example.test/mcp' }))).toThrow('credentials')
    expect(() => new McpOAuthConnection(store, spec({ resourceUrl: `${SERVER}#frag` }))).toThrow('fragment')
    expect(() => new McpOAuthConnection(store, spec({ redirectUri: 'not a url' }))).toThrow('absolute URL')
    expect(() => new McpOAuthConnection(store, spec({ clientName: '' }))).toThrow('clientName')
    expect(() => new McpOAuthConnection(store, spec({ refreshLeewayMs: -1 }))).toThrow('refreshLeewayMs')
  })

  it('classifies engine errors by code', () => {
    const error = new McpOAuthError('x', 'STALE')
    expect(isMcpOAuthError(error, 'STALE', 'DISPOSED')).toBe(true)
    expect(isMcpOAuthError(error, 'DISPOSED')).toBe(false)
    expect(isMcpOAuthError(new Error('x'))).toBe(false)
  })
})

describe('bounded fetch under adversarial external fetches', () => {
  const policy = { allowedOrigins: new Set([ISSUER]), requestTimeoutMs: 100, responseByteLimit: 64 }
  const target = `${ISSUER}/token`

  it('makes no call for a pre-aborted operation, even when the external fetch would ignore the abort', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    controller.abort(new McpOAuthError('cancelled first', 'CANCELLED'))
    const failures: McpOAuthError[] = []
    const ignoring = async (url: string | URL): Promise<Response> => {
      calls.push(String(url))
      return new Promise<Response>(() => {})
    }
    const fetchFn = createBoundedFetch(ignoring, policy, controller.signal, (e) => { failures.push(e) })
    await rejects(fetchFn(target), 'CANCELLED')
    expect(calls).toEqual([])
    expect(failures.map(f => f.code)).toEqual(['CANCELLED'])
  })

  it('settles within the time bound when the external fetch ignores the abort, then closes the late response body', async () => {
    let cancelled: unknown
    const late = Promise.withResolvers<Response>()
    const fetchFn = createBoundedFetch(() => late.promise, policy, new AbortController().signal, () => {})
    const started = Date.now()
    await rejects(fetchFn(target), 'NETWORK')
    expect(Date.now() - started).toBeLessThan(1000)
    late.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)) }, cancel(reason) { cancelled = reason } })))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(cancelled).toMatchObject({ code: 'NETWORK' })
    const bodyless = Promise.withResolvers<Response>()
    const again = createBoundedFetch(() => bodyless.promise, policy, new AbortController().signal, () => {})
    await rejects(again(target), 'NETWORK')
    bodyless.resolve(new Response(null, { status: 204 }))
    await new Promise(resolve => setTimeout(resolve, 5))
  })

  it('reports the byte bound even when cancelling the oversized body never settles', async () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(65)) },
      cancel: () => new Promise<void>(() => {}),
    })
    const fetchFn = createBoundedFetch(async () => new Response(body), policy, new AbortController().signal, () => {})
    const response = await fetchFn(target)
    await expect(response.text()).rejects.toMatchObject({ code: 'RESPONSE_BOUND' })
  })

  it('refuses a redirect status, a response from another origin, and targets with userinfo or a fragment', async () => {
    const redirected = new Response('', { status: 302, headers: { location: 'https://evil.example.test/' } })
    const redirect = createBoundedFetch(async () => redirected, policy, new AbortController().signal, () => {})
    await rejects(redirect(target), 'NETWORK')
    const elsewhere = createBoundedFetch(async () => {
      const response = new Response('{}')
      Object.defineProperty(response, 'url', { value: 'https://evil.example.test/token' })
      return response
    }, policy, new AbortController().signal, () => {})
    await rejects(elsewhere(target), 'ENDPOINT_NOT_ALLOWED')
    const calls: string[] = []
    const honest = createBoundedFetch(async (url) => {
      calls.push(String(url))
      return new Response(null, { status: 204 })
    }, policy, new AbortController().signal, () => {})
    await rejects(honest('https://user:pw@issuer.example.test/token'), 'ENDPOINT_NOT_ALLOWED')
    await rejects(honest(`${target}#frag`), 'ENDPOINT_NOT_ALLOWED')
    expect(calls).toEqual([])
    expect((await honest(target)).status).toBe(204)
  })

  it('wraps an external fetch that throws synchronously, without keeping its cause chain', async () => {
    const failing = createBoundedFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED leaked access-secret') })
    }, policy, new AbortController().signal, () => {})
    const error = await rejects(failing(target), 'NETWORK')
    expect(inspect(error, { depth: 8 })).not.toMatch(SECRET)
    expect(error.cause).toMatchObject({ message: 'failure without a recognized code' })
  })

  it('rejects discovery endpoints carrying userinfo', () => {
    const resolved = resolveMcpOAuthSpec(spec())
    const discovery = {
      authorizationServerUrl: `${ISSUER}/`,
      authorizationServerMetadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: 'https://user:pw@issuer.example.test/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    } as unknown as OAuthDiscoveryState
    expect(() => validateDiscovery(discovery, resolved)).toThrow('userinfo')
  })

  it('classifies causes without echoing any message, name, or unbounded code', () => {
    const hostile = new Error('access-secret-in-message')
    hostile.name = 'refresh-secret-in-name'
    Object.assign(hostile, { code: 'code-1 leaked', input: 'leaked input' })
    const wrapped = new McpOAuthError('x', 'NETWORK', { cause: hostile })
    expect(inspect(wrapped, { depth: 8 })).not.toMatch(SECRET)
    expect(wrapped.cause).toMatchObject({ message: 'failure without a recognized code' })
    expect(Object.keys(wrapped.cause as object)).toEqual([])
    expect(new McpOAuthError('x', 'NETWORK', { cause: Object.assign(new Error('leaked'), { code: 'ECONNREFUSED' }) }).cause)
      .toMatchObject({ message: 'failure with code ECONNREFUSED' })
    expect(new McpOAuthError('x', 'NETWORK', { cause: new DOMException('leaked', 'AbortError') }).cause).toMatchObject({ message: 'aborted' })
    expect(new McpOAuthError('x', 'NETWORK', { cause: 'leaked text' }).cause).toMatchObject({ message: 'non-error failure' })
    expect(new McpOAuthError('x', 'NETWORK', { cause: undefined }).cause).toBeUndefined()
    const oauth = Object.assign(new (class extends OAuthError { static override errorCode = 'leaked code' })('leaked description'), {})
    expect(new McpOAuthError('x', 'PROTOCOL', { cause: oauth }).cause).toMatchObject({ message: 'OAuth error with an unrecognized code' })
  })

  it('refuses a commit the credential store did not run, and a store failure during the exchange', async () => {
    const declining = memoryStore()
    declining.modifyRecord = () => Promise.resolve(undefined)
    const fixture = new Fixture({}, { server: SERVER, issuer: ISSUER })
    const connection = new McpOAuthConnection(declining, spec(), { fetch: fixture.fetch })
    const error = await rejects(connection.authorize(surface(fixture).session), 'PROTOCOL')
    expect(error.message).toContain('declined the commit')
    const failing = memoryStore()
    failing.modifyRecord = () => Promise.reject(new Error('leaked access-secret in store error'))
    const other = new Fixture({}, { server: SERVER, issuer: ISSUER })
    const second = new McpOAuthConnection(failing, spec(), { fetch: other.fetch })
    const failure = await rejects(second.authorize(surface(other).session), 'PROTOCOL')
    expect(inspect(failure, { depth: 8 })).not.toMatch(SECRET)
  })
})

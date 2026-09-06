/**
 * In-memory OAuth authorization server plus MCP resource behind one fetch,
 * for tests of the OAuth engine and of the Host connection owner over the
 * real engine. The engine's production validation and bounds run above it:
 * the fake only answers HTTP.
 */

import { createHash } from 'node:crypto'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

let sequence = 0

/**
 * Next value of the global order shared by fixture calls and test stores.
 * @returns a strictly increasing sequence number.
 */
export function nextSequence(): number {
  return ++sequence
}

export interface FixtureOptions {
  /** Advertise RFC 9207 `iss` support and include `iss` on callbacks. */
  iss?: boolean
  /** Advertise a revocation endpoint (default true) and how it answers. */
  revocation?: 'ok' | 'error' | 'none'
  /** How the token endpoint answers a refresh_token grant. */
  refresh?: 'rotate' | 'omit' | 'invalid_grant' | 'invalid_client' | 'error'
  /** Authorization server named by protected resource metadata (default the issuer). */
  prmIssuer?: string
  /** Resource named by protected resource metadata (default the server). */
  prmResource?: string
  /** Origin of the metadata's endpoints (default the issuer). */
  endpointOrigin?: string
  /** How the authorization server metadata body is delivered. */
  metadataBody?: 'normal' | 'chunked-large' | 'lying-length' | 'stalled' | 'declared-large'
  /** Reject every bearer token at the MCP endpoint. */
  rejectAll?: boolean
  /** How dynamic registration answers; `error` and `garbage` bodies carry a secret-looking description. */
  register?: 'ok' | 'error' | 'garbage' | 'other-redirect'
  /** How the code exchange answers. */
  exchange?: 'ok' | 'invalid_grant' | 'mac'
  /** Whether issued grants carry a refresh token (default true). */
  refreshTokens?: boolean
  /** Advertised access-token lifetime in seconds; `null` advertises none. */
  expiresIn?: number | null
  /** Serve protected resource metadata (default true). */
  prm?: boolean
  /** Client authentication the server registers and accepts. */
  clientAuth?: 'none' | 'client_secret_basic' | 'client_secret_post'
  /** Pathname whose requests fail at the network layer. */
  throwOn?: string
  /** Scope string token responses carry; `omit` leaves it out (default `tools:read`). */
  scopeInResponse?: string
}

export interface Call { sequence: number; method: string; url: URL; headers: Headers; body: string }
interface Gate { promise: Promise<undefined>; honorAbort: boolean }

/** In-memory authorization server plus MCP resource behind one fetch. */
export class Fixture {
  readonly calls: Call[] = []
  readonly accessTokens = new Set<string>()
  refreshToken: string | undefined
  private serial = 0
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  private readonly gates = new Map<string, Gate>()
  /** Handles authenticated MCP requests; default answers JSON `{ ok: true }`. */
  mcp: ((request: Request) => Promise<Response>) | undefined
  readonly fetch: FetchLike

  readonly server: string
  readonly issuer: string
  readonly serverOrigin: string

  constructor(readonly options: FixtureOptions = {}, identity: { server: string; issuer: string }) {
    this.server = identity.server
    this.issuer = identity.issuer
    this.serverOrigin = new URL(identity.server).origin
    this.fetch = (url, init) => this.handle(url, init)
  }

  calledPaths(): string[] {
    return this.calls.map(call => `${call.method} ${call.url.pathname}`)
  }

  /** Hold every request to `pathname` until released; a held request ignores its abort signal unless told to honor it. */
  hold(pathname: string, honorAbort = false): () => void {
    const gate = Promise.withResolvers<undefined>()
    this.gates.set(pathname, { promise: gate.promise, honorAbort })
    return () => { this.gates.delete(pathname); gate.resolve(undefined) }
  }

  /** Approve the authorization URL the engine announced and return the callback URL the browser would land on. */
  approve(authorizationUrl: string, overrides: Record<string, string | undefined> = {}): string {
    const url = new URL(authorizationUrl)
    const challenge = url.searchParams.get('code_challenge')
    const redirectUri = url.searchParams.get('redirect_uri')
    const clientId = url.searchParams.get('client_id')
    const state = url.searchParams.get('state')
    if (challenge === null || redirectUri === null || clientId === null || state === null) throw new Error('authorization URL is incomplete')
    if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE method is not S256')
    const code = `code-${++this.serial}`
    this.codes.set(code, { challenge, redirectUri, clientId })
    const callback = new URL(redirectUri)
    const params: Record<string, string | undefined> = { code, state, ...(this.options.iss ? { iss: this.issuer } : {}), ...overrides }
    for (const [name, value] of Object.entries(params)) if (value !== undefined) callback.searchParams.set(name, value)
    return callback.href
  }

  private metadata(): Record<string, unknown> {
    const origin = this.options.endpointOrigin ?? this.issuer
    return {
      issuer: this.issuer,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      ...(this.options.revocation === 'none' ? {} : { revocation_endpoint: `${origin}/revoke` }),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      ...(this.options.clientAuth === undefined ? {} : {
        token_endpoint_auth_methods_supported: [this.options.clientAuth],
        revocation_endpoint_auth_methods_supported: [this.options.clientAuth],
      }),
      ...(this.options.iss ? { authorization_response_iss_parameter_supported: true } : {}),
    }
  }

  private async handle(input: string | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = await request.text()
    this.calls.push({ sequence: nextSequence(), method: request.method, url, headers: request.headers, body })
    if (url.pathname === this.options.throwOn) throw new TypeError('fetch failed')
    const gate = this.gates.get(url.pathname)
    if (gate !== undefined) {
      const signal = init?.signal
      await (gate.honorAbort && signal !== undefined && signal !== null
        ? Promise.race([gate.promise, new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason as Error)
          signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
        })])
        : gate.promise)
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (this.options.prm === false) return new Response('', { status: 404 })
      return Response.json({
        resource: this.options.prmResource ?? this.server,
        authorization_servers: [this.options.prmIssuer ?? this.issuer],
      })
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return this.metadataResponse()
    if (url.pathname === '/register') {
      if (this.options.register === 'error') {
        return Response.json({ error: 'invalid_client_metadata', error_description: 'leaked access-secret-in-description' }, { status: 400 })
      }
      if (this.options.register === 'garbage') return new Response('code_verifier=leaked-in-raw-body', { status: 400 })
      const metadata = JSON.parse(body) as { redirect_uris: string[]; client_name: string }
      const auth = this.options.clientAuth ?? 'none'
      return Response.json({
        client_id: 'dcr-client',
        ...(auth === 'none' ? {} : { client_secret: 'client-secret-1' }),
        redirect_uris: this.options.register === 'other-redirect' ? ['https://client.example.test/other'] : metadata.redirect_uris,
        token_endpoint_auth_method: auth,
        client_name: metadata.client_name,
      }, { status: 201 })
    }
    if (url.pathname === '/token') return this.token(new URLSearchParams(body), request.headers)
    if (url.pathname === '/revoke') {
      this.authenticate(new URLSearchParams(body), request.headers)
      return this.options.revocation === 'error' ? new Response('', { status: 503 }) : new Response(null, { status: 204 })
    }
    if (url.origin === this.serverOrigin) {
      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '')
      if (this.options.rejectAll || bearer === undefined || !this.accessTokens.has(bearer)) {
        return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${this.serverOrigin}/.well-known/oauth-protected-resource/mcp"` } })
      }
      if (this.mcp === undefined) return Response.json({ ok: true, token: bearer })
      return this.mcp(new Request(request.url, {
        method: request.method,
        headers: request.headers,
        ...(body === '' ? {} : { body }),
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      }))
    }
    return new Response('', { status: 404 })
  }

  private metadataResponse(): Response {
    const json = JSON.stringify(this.metadata())
    const large = new TextEncoder().encode(json + ' '.repeat(4096))
    switch (this.options.metadataBody ?? 'normal') {
      case 'normal': return Response.json(this.metadata())
      case 'chunked-large': return new Response(new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < large.byteLength; offset += 512) controller.enqueue(large.subarray(offset, offset + 512))
          controller.close()
        },
      }), { headers: { 'content-type': 'application/json' } })
      case 'lying-length': return new Response(new ReadableStream({
        start(controller) { controller.enqueue(large); controller.close() },
      }), { headers: { 'content-type': 'application/json', 'content-length': '10' } })
      case 'stalled': return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(json.slice(0, 5))) },
      }), { headers: { 'content-type': 'application/json' } })
      case 'declared-large': return new Response(json, { headers: { 'content-type': 'application/json', 'content-length': '999999' } })
    }
  }

  /** The client authentication the token and revocation endpoints observed; throws on a wrong method. */
  private authenticate(params: URLSearchParams, headers: Headers): void {
    const auth = this.options.clientAuth ?? 'none'
    const basic = headers.get('authorization')
    if (auth === 'client_secret_basic') {
      if (basic !== `Basic ${Buffer.from('dcr-client:client-secret-1').toString('base64')}`) throw new Error('expected client_secret_basic')
    } else if (auth === 'client_secret_post') {
      if (params.get('client_secret') !== 'client-secret-1' || params.get('client_id') !== 'dcr-client') throw new Error('expected client_secret_post')
    } else if (basic !== null || params.get('client_secret') !== null) {
      throw new Error('expected a public client')
    }
  }

  private token(params: URLSearchParams, headers: Headers): Response {
    this.authenticate(params, headers)
    const grant = params.get('grant_type')
    if (grant === 'authorization_code') {
      if (this.options.exchange === 'invalid_grant') {
        return Response.json({ error: 'invalid_grant', error_description: 'leaked refresh-secret-in-description' }, { status: 400 })
      }
      if (this.options.exchange === 'mac') return Response.json({ access_token: 'mac-secret', token_type: 'MAC' })
      const code = params.get('code') ?? ''
      const issued = this.codes.get(code)
      this.codes.delete(code)
      const verifier = params.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const clientId = this.options.clientAuth === 'client_secret_basic' ? 'dcr-client' : params.get('client_id')
      if (issued === undefined || issued.challenge !== challenge || issued.redirectUri !== params.get('redirect_uri') || issued.clientId !== clientId) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return this.issueTokens(this.options.refreshTokens !== false)
    }
    if (grant === 'refresh_token') {
      if (this.options.refresh === 'error') return new Response('', { status: 500 })
      if (this.options.refresh === 'invalid_client') return Response.json({ error: 'invalid_client' }, { status: 401 })
      if (this.options.refresh === 'invalid_grant' || params.get('refresh_token') !== this.refreshToken) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      this.refreshToken = undefined
      return this.issueTokens(this.options.refresh !== 'omit')
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }

  private issueTokens(rotateRefresh: boolean): Response {
    const serial = ++this.serial
    const accessToken = `access-secret-${serial}`
    this.accessTokens.add(accessToken)
    if (rotateRefresh) this.refreshToken = `refresh-secret-${serial}`
    const expiresIn = this.options.expiresIn === undefined ? 3600 : this.options.expiresIn
    return Response.json({
      access_token: accessToken,
      token_type: 'Bearer',
      ...(expiresIn === null ? {} : { expires_in: expiresIn }),
      ...(this.options.scopeInResponse === 'omit' ? {} : { scope: this.options.scopeInResponse ?? 'tools:read' }),
      ...(rotateRefresh ? { refresh_token: this.refreshToken } : {}),
    })
  }
}

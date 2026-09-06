/**
 * Durable and wire validation for the MCP OAuth engine: the resolved spec,
 * the grant binding that decides whether a stored grant may serve the current
 * settings, the JSON grant document stored as a `GrantRecord` payload, and
 * the checks applied to untrusted discovery metadata before any token or
 * client secret is transmitted.
 *
 * @module
 */

import { z } from 'zod'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { McpOAuthError } from './oauth-error.ts'

/** Server identity, client registration, and network bounds for one engine. */
export interface McpOAuthSpec {
  /** The credential record this engine owns; its scope names the owning plugin. */
  key: CredentialKey
  /** HTTPS MCP endpoint the transport talks to. */
  serverUrl: string | URL
  /** HTTPS issuer the discovered authorization server must equal exactly; no query or fragment. */
  expectedIssuerUrl: string | URL
  /** HTTPS RFC 8707 resource indicator; {@link serverUrl} must lie under it. */
  resourceUrl: string | URL
  /** Registered redirect URI: HTTPS, or HTTP on a loopback host; no query, fragment, or credentials. No listener is created for it. */
  redirectUri: string | URL
  /** Scopes requested at authorization; empty lets the server choose (SDK SEP-835 order). */
  scopes: readonly string[]
  /** Pre-registered public client id; absent means RFC 7591 dynamic registration. */
  clientId?: string
  /** Client name sent with dynamic registration. */
  clientName: string
  /** Wall-clock bound for each OAuth protocol request including its body, in milliseconds. */
  requestTimeoutMs: number
  /** Byte bound for each OAuth protocol response body. */
  responseByteLimit: number
  /** Refresh this long before the access token's advertised expiry, in milliseconds. */
  refreshLeewayMs: number
}

const BindingSchema = z.strictObject({
  serverUrl: z.string(),
  issuerUrl: z.string(),
  resourceUrl: z.string(),
  redirectUri: z.string(),
  clientId: z.string().optional(),
  scopes: z.array(z.string()),
})

/** Settings that must all match for a stored grant to serve the current engine. */
export type McpOAuthBinding = z.infer<typeof BindingSchema>

/** {@link McpOAuthSpec} after {@link resolveMcpOAuthSpec}: parsed URLs, frozen scopes, and the derived binding. */
export interface ResolvedMcpOAuthSpec {
  readonly key: CredentialKey
  readonly serverUrl: URL
  readonly issuerUrl: URL
  readonly resourceUrl: URL
  readonly redirectUri: URL
  readonly scopes: readonly string[]
  readonly clientId: string | undefined
  readonly clientName: string
  readonly requestTimeoutMs: number
  readonly responseByteLimit: number
  readonly refreshLeewayMs: number
  readonly binding: Readonly<McpOAuthBinding>
  /** Origins OAuth protocol requests may reach: the server (resource metadata) and the issuer. */
  readonly allowedOrigins: ReadonlySet<string>
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function invalidSpec(message: string, options?: ErrorOptions): McpOAuthError {
  return new McpOAuthError(message, 'INVALID_SPEC', options)
}

function parseUrl(value: string | URL, name: string): URL {
  try {
    return new URL(value)
  } catch (error) {
    throw invalidSpec(`${name} is not an absolute URL`, { cause: error })
  }
}

function requireHttps(value: string | URL, name: string): URL {
  const url = parseUrl(value, name)
  if (url.protocol !== 'https:') throw invalidSpec(`${name} must use https`)
  if (url.username !== '' || url.password !== '') throw invalidSpec(`${name} must not carry credentials`)
  return url
}

function requireBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidSpec(`${name} must be a positive integer`)
  return value
}

/**
 * The one explicit resolve step from raw spec to what the engine runs; every
 * URL, bound, and identifier is judged here so misconfiguration fails at
 * construction rather than during a token exchange.
 * @param spec - raw engine spec.
 * @returns the frozen resolved spec.
 * @throws {McpOAuthError} code `INVALID_SPEC`.
 */
export function resolveMcpOAuthSpec(spec: McpOAuthSpec): ResolvedMcpOAuthSpec {
  const serverUrl = requireHttps(spec.serverUrl, 'serverUrl')
  const issuerUrl = requireHttps(spec.expectedIssuerUrl, 'expectedIssuerUrl')
  if (issuerUrl.search !== '' || issuerUrl.hash !== '') throw invalidSpec('expectedIssuerUrl must not carry a query or fragment')
  const resourceUrl = requireHttps(spec.resourceUrl, 'resourceUrl')
  if (resourceUrl.hash !== '') throw invalidSpec('resourceUrl must not carry a fragment')
  if (!checkResourceAllowed({ requestedResource: serverUrl, configuredResource: resourceUrl })) {
    throw invalidSpec('serverUrl must lie under resourceUrl')
  }
  const redirectUri = parseUrl(spec.redirectUri, 'redirectUri')
  const loopback = redirectUri.protocol === 'http:' && LOOPBACK_HOSTS.has(redirectUri.hostname)
  if (redirectUri.protocol !== 'https:' && !loopback) throw invalidSpec('redirectUri must use https or an http loopback host')
  if (redirectUri.search !== '' || redirectUri.hash !== '' || redirectUri.username !== '' || redirectUri.password !== '') {
    throw invalidSpec('redirectUri must not carry a query, fragment, or credentials')
  }
  if (spec.clientId !== undefined && spec.clientId === '') throw invalidSpec('clientId must be non-empty when given')
  if (spec.clientName === '') throw invalidSpec('clientName must be non-empty')
  const scopes = Object.freeze([...spec.scopes])
  if (scopes.some(scope => scope === '' || /\s/.test(scope))) throw invalidSpec('scopes must be non-empty tokens without whitespace')
  const binding: Readonly<McpOAuthBinding> = Object.freeze({
    serverUrl: serverUrl.href,
    issuerUrl: issuerUrl.href,
    resourceUrl: resourceUrl.href,
    redirectUri: redirectUri.href,
    ...(spec.clientId === undefined ? {} : { clientId: spec.clientId }),
    scopes: [...scopes],
  })
  return Object.freeze({
    key: spec.key,
    serverUrl,
    issuerUrl,
    resourceUrl,
    redirectUri,
    scopes,
    clientId: spec.clientId,
    clientName: spec.clientName,
    requestTimeoutMs: requireBound(spec.requestTimeoutMs, 'requestTimeoutMs'),
    responseByteLimit: requireBound(spec.responseByteLimit, 'responseByteLimit'),
    refreshLeewayMs: requireBound(spec.refreshLeewayMs, 'refreshLeewayMs'),
    binding,
    allowedOrigins: new Set([serverUrl.origin, issuerUrl.origin]),
  })
}

/**
 * A fresh, mutable copy of a binding for a document about to be stored.
 * @param binding - the binding to copy.
 * @returns the copy.
 */
export function bindingDocument(binding: Readonly<McpOAuthBinding>): McpOAuthBinding {
  return { ...binding, scopes: [...binding.scopes] }
}

/**
 * Whether two bindings agree on every setting, scopes compared as ordered lists.
 * @param a - one binding.
 * @param b - the other binding.
 * @returns true when a grant under `a` may serve an engine under `b`.
 */
export function sameBinding(a: Readonly<McpOAuthBinding>, b: Readonly<McpOAuthBinding>): boolean {
  return a.serverUrl === b.serverUrl && a.issuerUrl === b.issuerUrl && a.resourceUrl === b.resourceUrl
    && a.redirectUri === b.redirectUri && a.clientId === b.clientId
    && a.scopes.length === b.scopes.length && a.scopes.every((scope, index) => scope === b.scopes[index])
}

const DiscoverySchema = z.strictObject({
  authorizationServerUrl: z.string(),
  resourceMetadataUrl: z.string().optional(),
  authorizationServerMetadata: z.union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema]),
  resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
})

/** Registration information as stored: the RFC 7591 response when it registered dynamically, else the bare client id. */
export const ClientInformationSchema = z.union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])

/**
 * The JSON document stored as the grant payload. `epoch` advances on every
 * committed write and is the compare-and-set target of every engine commit.
 * Tokens exist only while `status` is `authorized`; `invalidated` records a
 * grant the authorization server rejected, `revoked` the local tombstone.
 */
export const GrantDocumentSchema = z.strictObject({
  format: z.literal(1),
  binding: BindingSchema,
  epoch: z.int().nonnegative(),
  status: z.enum(['authorized', 'invalidated', 'revoked']),
  tokens: OAuthTokensSchema.optional(),
  tokensIssuedAt: z.int().nonnegative().optional(),
  clientInformation: ClientInformationSchema.optional(),
  discovery: DiscoverySchema.optional(),
}).refine(
  doc => doc.status !== 'authorized' || (doc.tokens !== undefined && doc.tokensIssuedAt !== undefined && doc.clientInformation !== undefined && doc.discovery !== undefined),
  'an authorized grant carries tokens, issue time, client information, and discovery',
).refine(doc => doc.status === 'authorized' || doc.tokens === undefined, 'only an authorized grant carries tokens')
  .refine(doc => doc.tokens === undefined || doc.tokens.token_type.toLowerCase() === 'bearer', 'only bearer tokens are supported')

/** Validated grant document. */
export type GrantDocument = z.infer<typeof GrantDocumentSchema>

/** Discovery that passed {@link validateDiscovery}: the SDK's discovery state with metadata required. */
export interface ValidatedDiscovery extends OAuthDiscoveryState {
  authorizationServerMetadata: AuthorizationServerMetadata
}

/** What the stored record means for this engine. */
export type GrantView =
  /** Nothing is stored. */
  | { readonly kind: 'none'; readonly epoch: undefined }
  /** A record is stored but is not a valid grant document for this engine's format. */
  | { readonly kind: 'invalid'; readonly epoch: undefined }
  /** A valid grant bound to other settings; never served, replaced by the next authorization. */
  | { readonly kind: 'foreign'; readonly epoch: number }
  /** A valid grant bound to this engine's settings, its stored discovery re-validated against the spec. */
  | { readonly kind: 'grant'; readonly epoch: number; readonly doc: GrantDocument; readonly discovery: ValidatedDiscovery | undefined }

/**
 * Interpret a stored credential record for one engine. Every field is
 * validated on the way in; a document whose stored discovery no longer
 * satisfies the spec is `invalid` rather than partially trusted.
 * @param record - the record as the credential store returned it.
 * @param spec - the engine's resolved spec.
 * @returns the record's meaning for this engine.
 */
export function viewGrantRecord(record: CredentialRecord | undefined, spec: ResolvedMcpOAuthSpec): GrantView {
  if (record === undefined) return { kind: 'none', epoch: undefined }
  if (record.kind !== 'grant') return { kind: 'invalid', epoch: undefined }
  const parsed = GrantDocumentSchema.safeParse(record.payload)
  if (!parsed.success) return { kind: 'invalid', epoch: undefined }
  const doc = parsed.data
  if (!sameBinding(doc.binding, spec.binding)) return { kind: 'foreign', epoch: doc.epoch }
  let discovery: ValidatedDiscovery | undefined
  if (doc.discovery !== undefined) {
    try {
      discovery = validateDiscovery(doc.discovery, spec)
    } catch {
      // A stored discovery that fails the spec is a corrupt or tampered record, reported as invalid rather than trusted.
      return { kind: 'invalid', epoch: undefined }
    }
  }
  return { kind: 'grant', epoch: doc.epoch, doc, discovery }
}

function rejectDiscovery(message: string, options?: ErrorOptions): McpOAuthError {
  return new McpOAuthError(message, 'DISCOVERY_REJECTED', options)
}

function endpointOrigin(value: string | undefined, name: string, issuer: URL): void {
  if (value === undefined) return
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw rejectDiscovery(`authorization server metadata ${name} is not a URL`, { cause: error })
  }
  if (url.protocol !== 'https:' || url.origin !== issuer.origin) throw rejectDiscovery(`authorization server metadata ${name} is outside the issuer origin`)
  if (url.username !== '' || url.password !== '' || url.hash !== '') throw rejectDiscovery(`authorization server metadata ${name} carries userinfo or a fragment`)
}

/**
 * Judge untrusted discovery state against the spec before the SDK may send a
 * token, code, verifier, or client secret anywhere it names: the
 * authorization server must be exactly the expected issuer, every endpoint
 * must share the issuer origin over HTTPS, the protected resource must be
 * exactly the configured resource, and PKCE S256 must be advertised.
 * @param state - discovery state from the SDK or from the stored record.
 * @param spec - the engine's resolved spec.
 * @returns the same state, typed with metadata present.
 * @throws {McpOAuthError} code `DISCOVERY_REJECTED`.
 */
export function validateDiscovery(state: OAuthDiscoveryState | GrantDocument['discovery'] & object, spec: ResolvedMcpOAuthSpec): ValidatedDiscovery {
  let authorizationServer: URL
  try {
    authorizationServer = new URL(state.authorizationServerUrl)
  } catch (error) {
    throw rejectDiscovery('discovered authorization server is not a URL', { cause: error })
  }
  if (authorizationServer.href !== spec.issuerUrl.href) throw rejectDiscovery('discovered authorization server is not the expected issuer')
  const metadata: AuthorizationServerMetadata | undefined = state.authorizationServerMetadata
  if (metadata === undefined) throw rejectDiscovery('authorization server metadata is required')
  if (!URL.canParse(metadata.issuer) || new URL(metadata.issuer).href !== spec.issuerUrl.href) throw rejectDiscovery('authorization server metadata issuer is not the expected issuer')
  endpointOrigin(metadata.authorization_endpoint, 'authorization_endpoint', spec.issuerUrl)
  endpointOrigin(metadata.token_endpoint, 'token_endpoint', spec.issuerUrl)
  endpointOrigin(metadata.registration_endpoint, 'registration_endpoint', spec.issuerUrl)
  endpointOrigin('revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined, 'revocation_endpoint', spec.issuerUrl)
  if (!metadata.response_types_supported.includes('code')) throw rejectDiscovery('authorization server does not support the code response type')
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw rejectDiscovery('authorization server does not advertise PKCE S256')
  if (state.resourceMetadata !== undefined) {
    const resource = state.resourceMetadata.resource
    if (!URL.canParse(resource) || new URL(resource).href !== spec.resourceUrl.href) throw rejectDiscovery('protected resource metadata names another resource')
  }
  if (state.resourceMetadataUrl !== undefined) {
    if (!URL.canParse(state.resourceMetadataUrl) || !spec.allowedOrigins.has(new URL(state.resourceMetadataUrl).origin)) {
      throw rejectDiscovery('protected resource metadata URL is outside the allowed origins')
    }
  }
  return {
    authorizationServerUrl: authorizationServer.href,
    authorizationServerMetadata: metadata,
    ...(state.resourceMetadata === undefined ? {} : { resourceMetadata: state.resourceMetadata }),
    ...(state.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: state.resourceMetadataUrl }),
  }
}

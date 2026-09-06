/**
 * Typed failure classes of the MCP OAuth engine. Messages are fixed strings
 * that never carry tokens, codes, verifiers, callback URLs, or response
 * bodies; the wire-level cause stays on `cause` for diagnostics.
 *
 * @module
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'

/** Stable machine-routable failure classes of {@link McpOAuthError}. */
export type McpOAuthErrorCode =
  /** The engine spec is not a usable HTTPS server, issuer, resource, redirect, or bound. */
  | 'INVALID_SPEC'
  /** No grant can serve this request: none stored, revoked, invalidated, or bound to other settings. */
  | 'AUTH_REQUIRED'
  /** An explicit authorization attempt is already running on this engine. */
  | 'ALREADY_IN_FLIGHT'
  /** The authorization attempt was withdrawn through its session signal. */
  | 'CANCELLED'
  /** The engine was disposed. */
  | 'DISPOSED'
  /** The operation lost to a concurrent commit and its result was discarded. */
  | 'STALE'
  /** The pasted callback URL failed redirect, state, issuer, or code validation. */
  | 'CALLBACK_INVALID'
  /** Untrusted discovery metadata named an issuer, resource, or endpoint outside the spec. */
  | 'DISCOVERY_REJECTED'
  /** An OAuth protocol request targeted an origin outside the spec allowlist. */
  | 'ENDPOINT_NOT_ALLOWED'
  /** An OAuth protocol request failed, timed out, or was aborted. */
  | 'NETWORK'
  /** An OAuth protocol response exceeded the configured byte bound. */
  | 'RESPONSE_BOUND'
  /** Token refresh failed for a reason that leaves the stored grant usable later. */
  | 'REFRESH_FAILED'
  /** A managed request tried to supply its own Authorization, Proxy-Authorization, or Cookie header. */
  | 'MANAGED_HEADER'
  /** The authorization server or the OAuth client library rejected a protocol step; the cause carries the detail. */
  | 'PROTOCOL'
  /** The credential store rejected a durable write; what it holds now is not what the engine intended. */
  | 'STORE'

/** OAuth error codes (RFC 6749 §5.2 style) and Node/harness error codes are short fixed identifiers; anything else is not echoed. */
const OAUTH_CODE_PATTERN = /^[a-z_]{1,40}$/
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/

/**
 * Reduce an untrusted failure to a fixed classification with no message,
 * properties, or cause chain, so `util.inspect` of an engine error prints
 * nothing the authorization server, the credential store, or a caller put in
 * it. Kept: whether it was an OAuth error and its error code when that code
 * has the bounded RFC shape; whether it was an abort; and a `code` property
 * with the bounded Node/harness shape. Dropped: every message (including
 * `error_description`, raw response bodies, and URL parse inputs), the
 * `name` a caller could set to anything, and deeper causes.
 * @param cause - the failure to classify.
 * @returns a plain error safe to attach as `cause`.
 */
export function sanitizeCause(cause: unknown): Error {
  if (cause instanceof OAuthError) {
    const code: unknown = cause.errorCode
    return new Error(`OAuth error ${typeof code === 'string' && OAUTH_CODE_PATTERN.test(code) ? code : 'with an unrecognized code'}`)
  }
  if (cause instanceof Error) {
    if (cause.name === 'AbortError') return new Error('aborted')
    const code: unknown = (cause as { code?: unknown }).code
    return new Error(typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? `failure with code ${code}` : 'failure without a recognized code')
  }
  return new Error('non-error failure')
}

/** Failure of one MCP OAuth engine operation; route on {@link McpOAuthError.code}. */
export class McpOAuthError extends HarnessError {
  override readonly code: McpOAuthErrorCode

  /**
   * @param message - fixed engine text; never interpolate server, store, or caller input.
   * @param code - the failure class.
   * @param options - `cause` is passed through {@link sanitizeCause} before it is kept.
   */
  constructor(message: string, code: McpOAuthErrorCode, options?: ErrorOptions) {
    super(message, code, options?.cause === undefined ? undefined : { cause: sanitizeCause(options.cause) })
    this.code = code
    this.name = 'McpOAuthError'
  }
}

/**
 * Whether an error is an {@link McpOAuthError} carrying one of the given codes.
 * @param error - any thrown value.
 * @param codes - codes to match; empty matches every engine error.
 * @returns true when `error` is an engine error with a matching code.
 */
export function isMcpOAuthError(error: unknown, ...codes: McpOAuthErrorCode[]): error is McpOAuthError {
  return error instanceof McpOAuthError && (codes.length === 0 || codes.includes(error.code))
}

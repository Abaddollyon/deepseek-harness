/**
 * Cache-Control policy for the Web carrier: which answers a browser may reuse
 * without asking, and which it must revalidate.
 * @module @deepseek-ai/dsh-host-webserver/response-cache
 */

/** The deployment-settable cache policy. */
export interface CachePolicy {
  /**
   * Absolute pathname prefixes whose every file the build writes with its
   * content hash in the filename.
   */
  immutablePathPrefixes: readonly string[]
  /** `max-age` seconds attached to an immutable pathname answer. */
  immutableMaxAgeSeconds: number
}

/**
 * Directive for every answer not covered by an immutable pathname prefix.
 * `no-cache` stores
 * the answer but forbids reusing it without revalidating, so the conditional
 * request still ends in a cheap 304 while a new build is picked up on the
 * next load.
 */
export const REVALIDATED_CACHE_CONTROL = 'no-cache'

/**
 * Decide the `Cache-Control` value for one answer.
 *
 * A response is immutable only when its pathname starts with one of the
 * configured `immutablePathPrefixes`. Query parameters, including
 * `?rev=<hash>`, do not grant immutability because the carrier cannot
 * independently prove that they hash the served bytes. A stored copy of an
 * answer under a configured prefix therefore earns `immutable`; an answer
 * outside those prefixes remains revalidated.
 *
 * Two rules keep that from serving a stale GUI:
 *
 * - The entry document is never content-addressed, so it always revalidates.
 *   It is the document that names the current asset and bundle URLs, so as
 *   long as it is re-fetched, a new build's hashed URLs are new URLs and are
 *   fetched with it. Pinning it instead would freeze the whole app.
 * - `text/html` never earns `immutable`, whatever the URL looks like. The SPA
 *   fallback answers a miss anywhere — including under an immutable prefix —
 *   with index.html and status 200, so a mistyped hashed URL would otherwise
 *   pin the shell under an address the build never emits again.
 *
 * @param requestUrl - the request target as node:http reports it (path plus query).
 * @param contentType - the answer's `Content-Type` field, if present.
 * @param policy - the deployment's prefixes and immutable lifetime.
 * @returns the `Cache-Control` field value.
 */
export function cacheControlFor(
  requestUrl: string,
  contentType: string | undefined,
  policy: CachePolicy,
): string {
  const mediaType = (contentType?.split(';')[0] ?? '').trim().toLowerCase()
  if (mediaType === 'text/html') return REVALIDATED_CACHE_CONTROL
  const url = new URL(requestUrl, 'http://x')
  const contentAddressed = policy.immutablePathPrefixes.some(prefix => url.pathname.startsWith(prefix))
  if (!contentAddressed) return REVALIDATED_CACHE_CONTROL
  return `public, max-age=${String(policy.immutableMaxAgeSeconds)}, immutable`
}

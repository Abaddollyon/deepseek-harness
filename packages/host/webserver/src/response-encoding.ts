/**
 * Accept-Encoding negotiation and body compressors for the Web carrier.
 * Pure decision functions plus the two `node:zlib` transforms behind them;
 * the response patch in `./response-policy.ts` owns when they run.
 * @module @deepseek-ai/dsh-host-webserver/response-encoding
 */

import type { Transform } from 'node:stream'
import { constants, createBrotliCompress, createGzip } from 'node:zlib'

/** A content coding this carrier can emit; `identity` is the unencoded body. */
export type ResponseEncoding = 'br' | 'gzip' | 'identity'

/** Quality/level knobs the compressors are built with. */
export interface CompressorLevels {
  /** Brotli quality, 0-11 (BROTLI_PARAM_QUALITY). */
  brotliQuality: number
  /** Deflate level, 0-9 (zlib `level`). */
  gzipLevel: number
}

/**
 * Server preference among the codings this process implements, best ratio
 * first. Fixed, not configurable: it states what the carrier can produce, and
 * a client that prefers otherwise says so with its own q-values, which
 * {@link selectResponseEncoding} honours ahead of this order.
 */
const SERVER_PREFERENCE: readonly ResponseEncoding[] = ['br', 'gzip', 'identity']

/**
 * Media types outside `text/*` whose bodies are worth compressing. An
 * allow-list rather than a deny-list, so an already-compressed payload
 * (`image/png`, `font/woff2`, `application/zip`, every `video/*`) is skipped
 * by not being named: spending CPU on it costs bytes rather than saving them.
 */
const COMPRESSIBLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'application/wasm',
  'application/xml',
  'application/x-ndjson',
  'image/svg+xml',
])

/** Parse one `Accept-Encoding` field into coding -> quality (RFC 9110 12.5.3). */
function acceptedQualities(header: string): Map<string, number> {
  const qualities = new Map<string, number>()
  for (const element of header.split(',')) {
    const [rawCoding, ...parameters] = element.split(';') as [string, ...string[]]
    const coding = rawCoding.trim().toLowerCase()
    if (coding === '') continue
    let quality = 1
    for (const parameter of parameters) {
      const separator = parameter.indexOf('=')
      if (separator === -1) continue
      if (parameter.slice(0, separator).trim().toLowerCase() !== 'q') continue
      const parsed = Number(parameter.slice(separator + 1).trim())
      // A malformed q-value is a refusal, not an invitation: the safe reading
      // of an unparseable weight is that the client did not ask for it.
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
    }
    qualities.set(coding, quality)
  }
  return qualities
}

/**
 * Choose the coding to answer one request with.
 *
 * Client weights decide first and {@link SERVER_PREFERENCE} breaks ties, so
 * `gzip;q=1.0, br;q=0.5` yields gzip while a plain `gzip, br` yields brotli.
 * A missing or blank field means the client offered nothing and gets
 * `identity`.
 *
 * An unmentioned `identity` takes the lowest weight the client did state, the
 * convention `negotiator` established: a client that ranks codings without
 * naming `identity` is asking to be encoded, so reading RFC 9110's "acceptable
 * by default" as q=1 would refuse every coding it just offered.
 *
 * The carrier never answers 406: when every coding including `identity` is
 * weighted zero it still sends the unencoded body, because an asset the
 * browser cannot render is a worse answer than one coding it did not rank.
 * @param header - the request's raw `Accept-Encoding` field, if present.
 * @returns the coding to emit.
 */
export function selectResponseEncoding(header: string | undefined): ResponseEncoding {
  if (header === undefined || header.trim() === '') return 'identity'
  const qualities = acceptedQualities(header)
  const wildcard = qualities.get('*')
  const statedQualities = [...qualities.values()]
  const identityFallback = wildcard ?? Math.min(...statedQualities)
  let best: ResponseEncoding = 'identity'
  let bestQuality = 0
  for (const coding of SERVER_PREFERENCE) {
    // A coding the client never mentioned is not offered; identity alone has
    // the fallback above, and SERVER_PREFERENCE's order breaks equal weights.
    const fallback = coding === 'identity' ? identityFallback : 0
    const quality = qualities.get(coding) ?? wildcard ?? fallback
    if (quality > bestQuality) {
      best = coding
      bestQuality = quality
    }
  }
  return best
}

/**
 * Decide whether a body of this media type is worth compressing.
 *
 * `text/event-stream` is excluded although it is text: an SSE response stays
 * open for the life of the channel, so buffering it to measure a size
 * threshold would withhold every event.
 * @param contentType - the response's `Content-Type` field, if present.
 * @returns true when the carrier should negotiate a coding for it.
 */
export function isCompressibleMediaType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  const [rawMediaType] = contentType.split(';') as [string, ...string[]]
  const mediaType = rawMediaType.trim().toLowerCase()
  if (mediaType === 'text/event-stream') return false
  if (mediaType.startsWith('text/')) return true
  if (COMPRESSIBLE_MEDIA_TYPES.has(mediaType)) return true
  return mediaType.endsWith('+json') || mediaType.endsWith('+xml')
}

/**
 * Build the transform that encodes a body with the chosen coding.
 * @param encoding - the negotiated coding (never `identity`; that path writes
 * the body through unchanged and never reaches a compressor).
 * @param levels - the configured quality and level.
 * @returns a transform stream whose readable side carries the encoded body.
 */
export function createCompressor(
  encoding: Exclude<ResponseEncoding, 'identity'>,
  levels: CompressorLevels,
): Transform {
  if (encoding === 'br') {
    return createBrotliCompress({
      params: { [constants.BROTLI_PARAM_QUALITY]: levels.brotliQuality },
    })
  }
  return createGzip({ level: levels.gzipLevel })
}

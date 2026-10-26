/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, LlmFailure, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage. pi-ai keeps reasoning inside output and reports the
 * provider's split, when there is one, as `usage.reasoning`: a sub-breakdown
 * of output, never an additional bucket.
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence), and `reasoningTokens`
 *   only when the provider reports the split, including a reported zero.
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
    ...usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning },
  }
}

/**
 * pi-ai's Codex adapter rewrites every 429 that carries a JSON error body into
 * this sentence, plan exhaustion (`usage_limit_reached`) included, and appends
 * the plan and `Try again in ~N min.` when the body names them. The rewrite
 * erases the provider's code, so the sentence marks a terminal quota failure.
 */
const CODEX_USAGE_LIMIT = /\bYou have hit your ChatGPT usage limit\b/i
const CODEX_USAGE_LIMIT_RESET = /\bTry again in ~(\d+) min\b/i

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  // HTTP/2 stream resets: nghttp2 reports a peer reset as `stream error:
  // stream ID N; <CODE>; received from peer`. Both fragments are required:
  // bare `stream error` is generic phrasing, and `received from peer` alone
  // appears in unrelated wording (TLS certificates). Node renders the reset
  // code as NGHTTP2_* and intermediaries name the RST_STREAM frame. The peer
  // reset one stream, not the connection, so resending the request can succeed.
  // Checked before status codes: the stream id can read like one (`stream ID 401;`).
  if (/\bstream error\b/i.test(message) && /received from peer/i.test(message)) return 'TRANSPORT'
  if (/RST_STREAM|NGHTTP2_/i.test(message)) return 'TRANSPORT'
  // Checked before status codes: the stated reset can read like one (`~401 min`).
  if (CODEX_USAGE_LIMIT.test(message)) return QUOTA_EXCEEDED_CODE
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  // An overload reported in-stream without an HTTP status: codex-lb's
  // `server_is_overloaded` failed response, Anthropic's `overloaded_error` SSE
  // error, and the OpenAI overload sentence. Unknown failures stay unclassified.
  if (/\b(?:servers? (?:are|is) (?:currently )?overloaded|overloaded_error|server_is_overloaded)\b/i.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  // codex-lb reports a lost upstream WebSocket as a failed response: its
  // `stream_incomplete` code with an upstream-transport or rejected-anchor
  // fragment, or `bridge_previous_response_not_found` carrying the close
  // message. Each is a truncation a fresh attempt can complete; any other
  // `stream_incomplete` reason (a cancelled scope) stays out of the retry loop.
  if ((/\bbridge_previous_response_not_found\b/i.test(message)
    && /upstream websocket closed before response\.completed/i.test(message))
    || /previous response anchor was rejected upstream/i.test(message)
    || (/\bstream_incomplete\b/i.test(message) && (/anchor|previous_response/i.test(message)
      || /upstream websocket (?:closed before response\.completed|closed without a complete handshake|receive failed)/i.test(message)))) {
    return 'TRANSPORT'
  }
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/** HTTP facts of the last response one pi-ai request received, observed through its `fetch`. */
export interface ObservedProviderResponse {
  /** HTTP status code. */
  readonly status: number
  /** Positive provider-requested retry delay in milliseconds, resolved when the response arrived. */
  readonly retryAfterMs?: number
}

function positiveDelay(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Parse a provider-requested retry delay. A valid positive `retry-after-ms`
 * (milliseconds, which the OpenAI and Anthropic SDKs also honour) wins over
 * `retry-after`, which carries delta-seconds or an HTTP-date.
 * @param headers - response headers.
 * @param nowMs - receipt time in epoch milliseconds, used to resolve an HTTP-date.
 * @returns the positive delay in milliseconds, or `undefined` when both headers
 *   are absent, malformed, zero, or name a past date.
 */
export function parseRetryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const milliseconds = headers.get('retry-after-ms')?.trim()
  const millisecondDelay = milliseconds === undefined || milliseconds === '' ? undefined : positiveDelay(Number(milliseconds))
  if (millisecondDelay !== undefined) return millisecondDelay
  const retryAfter = headers.get('retry-after')?.trim()
  if (retryAfter === undefined || retryAfter === '') return undefined
  const seconds = Number(retryAfter)
  return Number.isNaN(seconds) ? positiveDelay(Date.parse(retryAfter) - nowMs) : positiveDelay(seconds * 1000)
}

/** Failure codes an HTTP status determines when pi-ai's flattened error text is unrecognized. */
function statusFailureCode(status: number): string | undefined {
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  return status >= 500 ? 'SERVER' : undefined
}

/** The reset delay pi-ai's Codex usage-limit sentence states, in milliseconds. */
function codexUsageLimitResetMs(text: string): number | undefined {
  if (!CODEX_USAGE_LIMIT.test(text)) return undefined
  const minutes = CODEX_USAGE_LIMIT_RESET.exec(text)?.[1]
  return minutes === undefined ? undefined : positiveDelay(Number(minutes) * 60_000)
}

/**
 * Classify pi-ai error text, then add the failed HTTP response's status and
 * requested delay. Text classification wins; the status decides only text the
 * classifier leaves as `PI_AI_ERROR`, such as a provider's reworded 503 body.
 * A response header's delay wins over the reset a Codex usage-limit sentence states.
 */
function errorFailure(text: string, response: ObservedProviderResponse | undefined): LlmFailure {
  const classified = classifyPiAiError(text)
  const failed = response !== undefined && response.status >= 400 ? response : undefined
  const retryAfterMs = failed?.retryAfterMs ?? codexUsageLimitResetMs(text)
  return {
    message: text,
    code: failed !== undefined && classified === 'PI_AI_ERROR' ? statusFailureCode(failed.status) ?? classified : classified,
    ...failed === undefined ? {} : { status: failed.status },
    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
  }
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param response - the last HTTP response the request received, when its transport exposed one.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
 *   to non-retryable `PI_AI_ERROR` failures. Known status-less overloads map to
 *   `SERVER`, and pi-ai's Codex usage-limit sentence maps to non-retryable
 *   `QUOTA` whatever the status, carrying its stated reset as
 *   `providerRetryAfterMs` when no response header named a delay. An error
 *   after a failed HTTP `response` carries its `status` and
 *   `providerRetryAfterMs`, and unrecognized text after a 408, 429, or 5xx maps
 *   to `TIMEOUT`, `RATE_LIMIT`, or `SERVER`; other unclassified errors remain `PI_AI_ERROR`.
 */
export function mapStopReason(
  message: AssistantMessage,
  contextWindow?: number,
  response?: ObservedProviderResponse,
): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    // Without provider wording, pi-ai detects overflow only from usage against
    // the resolved window, so the fallback can name both.
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}" at resolved context`
          + ` window ${contextWindow} tokens (input ${message.usage.input}, cache-read ${message.usage.cacheRead})`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error':
      return { kind: 'error', failure: errorFailure(message.errorMessage ?? 'pi-ai stream error', response) }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity recorded for durable replay.
 * @param lastResponse - reads the last HTTP response of this request when the terminal event arrives.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event, or
 *   `MALFORMED_RESPONSE` when completed tool arguments are invalid. Length-limited
 *   output retains its terminal reason so the assembler can discard incomplete calls.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
  lastResponse?: () => ObservedProviderResponse | undefined,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()
  let argumentsError: string | undefined

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        if (event.toolCall.argumentsError !== undefined) {
          argumentsError ??= `Tool call "${event.toolCall.name}": ${event.toolCall.argumentsError}`
          break
        }
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        if (argumentsError !== undefined && event.message.stopReason !== 'length') {
          throw new LlmError(argumentsError, 'MALFORMED_RESPONSE')
        }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow, lastResponse?.()),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
            lastResponse?.(),
          ),
        }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}

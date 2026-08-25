# Agent Note: Classify pi-ai HTTP/2 stream resets as retryable transport failures

Status: implemented

English | [中文](2026-08-25-pi-ai-http2-stream-reset-classification.zh.md)

## Problem

An HTTP/2 provider or intermediary can reset a single stream mid-response (an nghttp2 `RST_STREAM` frame) while the connection itself stays healthy. pi-ai flattens that failure to message text such as `stream error: stream ID 1; INTERNAL_ERROR; received from peer` or Node's `NGHTTP2_*` error-code rendering, and `classifyPiAiError` in `dsh-llm-pi-ai` mapped none of these wordings: they fell through to the catch-all `PI_AI_ERROR`, which the default `llm-retry` policy does not retry. A reset of one stream — a classic transient that a fresh request usually survives — therefore failed the whole turn.

This behavior existed before as the `apply-rc6-http2-stream-retry` compiled-bundle patch and was silently dropped when compiled patching was retired in the upstream 0.1.1-rc.2 upgrade. This note records its re-landing in source, extending [the transport-truncation classification](2026-07-22-pi-ai-transport-truncation-classification.md).

## Decision

- `classifyPiAiError` maps HTTP/2 stream-reset vocabulary to `TRANSPORT`: nghttp2's `stream error: stream ID N; <CODE>; received from peer` wording (matched on `stream error` and `received from peer`), the `RST_STREAM` frame name, and the `NGHTTP2_` error-code prefix. The peer reset one stream, not the connection, so resending the request can succeed; the default retry policy already lists `TRANSPORT` as retryable.
- `received from peer`, `RST_STREAM`, and `NGHTTP2_` appear only in HTTP/2 reset vocabulary, so they cannot swallow genuine model-level errors. The bare `stream error` signature is broader by necessity: it is nghttp2's lead wording for exactly this failure.
- The no-detail error fallback in `mapStopReason` (`pi-ai stream error` when pi-ai reports a failure with no message) is now classified explicitly as `PI_AI_ERROR` instead of passing through the classifier: its literal text contains `stream error`, and an unknown cause must not enter the retry loop through the reset signature.
- A conversion test asserts the coupling end to end: reset wording classifies as `TRANSPORT` and the default resolved retry policy retries `TRANSPORT`.

## Alternatives considered

**Match only the full nghttp2 phrase (`stream error` plus `received from peer` together).** Rejected: Node's `ERR_HTTP2_STREAM_ERROR` renders as `Stream closed with error code NGHTTP2_*` without either phrase, and intermediaries emit the bare `RST_STREAM` frame name; requiring the composite would miss the renderings the signatures individually cover.

**Let the no-detail fallback classify as `TRANSPORT` too.** Rejected: the fallback means pi-ai reported a failure with no information at all; retrying an unknown cause up to the policy maximum wastes quota and delays surfaces of genuine persistent errors.

**Classify on a structured `code`/`cause` instead of text.** Still impossible, as the predecessor note records: pi-ai flattens the caught error to `error.message` before the terminal event, so text matching remains the only signal. The `XXX(pi-ai upstream)` note on the classifier still points at the durable fix.

## Consequences

- An HTTP/2 stream reset now retries under the default provider retry policy instead of failing the turn; persistent resets still terminate after the policy's configured retries.
- The failure text reaching the user is unchanged; only the routed `code` improved, exactly as with the truncation classification.
- Classification remains wording-dependent: an nghttp2 or Node release that rewords these errors silently falls back to `PI_AI_ERROR` until the patterns are updated.

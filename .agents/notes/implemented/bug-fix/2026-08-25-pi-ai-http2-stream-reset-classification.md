# Agent Note: Classify pi-ai HTTP/2 stream resets as retryable transport failures

Status: implemented

English | [中文](2026-08-25-pi-ai-http2-stream-reset-classification.zh.md)

## Problem

An HTTP/2 provider or intermediary can reset a single stream mid-response (an nghttp2 `RST_STREAM` frame) while the connection itself stays healthy. pi-ai flattens that failure to message text such as `stream error: stream ID 1; INTERNAL_ERROR; received from peer` or Node's `NGHTTP2_*` error-code rendering, and `classifyPiAiError` in `dsh-llm-pi-ai` mapped none of these wordings: they fell through to the catch-all `PI_AI_ERROR`, which the default `llm-retry` policy does not retry. A reset of one stream — a classic transient that a fresh request usually survives — therefore failed the whole turn.

This behavior existed before as the `apply-rc6-http2-stream-retry` compiled-bundle patch and was silently dropped when compiled patching was retired in the upstream 0.1.1-rc.2 upgrade. This note records its re-landing in source, extending [the transport-truncation classification](2026-07-22-pi-ai-transport-truncation-classification.md).

## Decision

- `classifyPiAiError` maps HTTP/2 stream-reset vocabulary to `TRANSPORT`. nghttp2's peer-reset rendering `stream error: stream ID N; <CODE>; received from peer` is matched as a composite: both `stream error` and `received from peer` must be present. Bare `stream error` is generic phrasing that application-level failures also carry (gRPC-style status text, payload decoders), and `received from peer` alone appears in unrelated wording (TLS certificates), so neither fragment classifies by itself. Node's `NGHTTP2_*` error-code rendering and the `RST_STREAM` frame name appear only in HTTP/2 reset vocabulary, so they classify standalone. The peer reset one stream, not the connection, so resending the request can succeed; the default retry policy already lists `TRANSPORT` as retryable.
- A locally reset stream (nghttp2 wording without `received from peer`) is not proven transient and stays `PI_AI_ERROR`.
- The no-detail error fallback in `mapStopReason` (`pi-ai stream error` when pi-ai reports a failure with no message) passes through the classifier like any other text and lands on `PI_AI_ERROR`: its literal `stream error` fragment lacks the `received from peer` half of the composite, so an unknown cause cannot enter the retry loop through the reset signature.
- Conversion tests assert the coupling end to end: reset wording classifies as `TRANSPORT` and the default resolved retry policy retries `TRANSPORT`, while the negative cases above stay on the non-retryable `PI_AI_ERROR`.

## Alternatives considered

**Match bare `stream error` alone, as the historical compiled patch did.** Rejected: the fragment is not reset-specific, so unrelated application-level failures containing those words would enter the retry loop and be resent up to the policy maximum — wasted quota and delayed surfacing of genuine persistent errors. The composite keeps the nghttp2 case covered while holding everything else out.

**Let the no-detail fallback classify as `TRANSPORT` too.** Rejected: the fallback means pi-ai reported a failure with no information at all; retrying an unknown cause up to the policy maximum wastes quota and delays surfaces of genuine persistent errors.

**Classify on a structured `code`/`cause` instead of text.** Still impossible, as the predecessor note records: pi-ai flattens the caught error to `error.message` before the terminal event, and that note's evaluation of current pi-ai's `StreamOptions.fetch` hook rejects capturing the `cause` through it (per-request side state across concurrent streams and pi-ai client retries, no WebSocket coverage). Text matching remains the only signal; the `XXX(pi-ai upstream)` note on the classifier still points at the durable fix.

## Consequences

- An HTTP/2 stream reset now retries under the default provider retry policy instead of failing the turn; persistent resets still terminate after the policy's configured retries.
- The failure text reaching the user is unchanged; only the routed `code` improved, exactly as with the truncation classification.
- Classification remains wording-dependent: an nghttp2 or Node release that rewords these errors silently falls back to `PI_AI_ERROR` until the patterns are updated.

# Agent Note: Classify status-less Codex overloads as server failures

Status: implemented

English | [中文](2026-09-05-codex-overload-classification.zh.md)

## Problem

Codex reports “Our servers are currently overloaded. Please try again later.” without an HTTP status. The generic `PI_AI_ERROR` classification prevents the normal retry policy from recovering this transient provider failure.

## Decision

The [pi-ai adapter](../../../../packages/llm/llm-pi-ai/README.md) classifies recognized server-overload messages as `SERVER`. Authentication, quota, and invalid-request classifications retain precedence; cancellation retains its separate finish reason. Unknown errors remain `PI_AI_ERROR`. This extends the message-based classification approach without superseding the independent [HTTP/2 reset decision](2026-08-25-pi-ai-http2-stream-reset-classification.md).

The existing retry plugin owns delay, cancellation, and budgets. Recovery repeats the failed inference within its step; it does not restart the turn or execute tool calls from an uncommitted response.

## Alternatives considered

Making every `PI_AI_ERROR` retryable would also retry malformed responses and configuration failures. Resubmitting the entire turn would risk repeating completed tool effects. Neither is necessary to recover a classified provider overload.

## Consequences

Normal mode retains its configured finite retry budget; explicitly configured policies are unchanged. Persistent overload still fails after that budget. Classification remains dependent on provider wording and does not increase provider capacity.

Conversion and retry tests cover the reported message, negative classifications, partial tool output, cancellation, and budget exhaustion. The authored [server-overload replay](../../../../snapshots/session/server-overload-retry/session.jsonl) records same-step recovery through the shipped headless profile; it is not a live Codex-provider test.

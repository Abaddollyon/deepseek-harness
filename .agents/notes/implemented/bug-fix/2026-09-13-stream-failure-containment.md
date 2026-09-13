# Agent Note: Stream failure containment and explicit read recovery

Status: implemented

English | [中文](2026-09-13-stream-failure-containment.zh.md)

## Problem

Asynchronous provider, subprocess, and JSON-RPC failures can escape the operation that owns them. A disconnected workspace feed can also exhaust its transport retries and leave the user without a working Retry action.

## Decision

Provider stream creation and consumption share the same error conversion. Rejected Codex response anchors retain their transport classification. Subprocess collection contains spill-file failures, retains a bounded output tail, and reports `spillFailure` so callers can distinguish incomplete persistence from complete output.

JSON-RPC terminal write errors settle pending requests and terminate the connection. Delayed inbound handlers cannot write after close, while a peer half-close still allows an already accepted request to receive its response.

Workspace feeds recognize an exhausted remote stream carrier as a retryable read failure. The explicit Retry action starts one fresh subscription and coalesces repeated clicks. Terminal Host errors remain terminal; this recovery never replays commands.

The CI runner traverses sampled process tables with a visited-PID set and individual queue insertions. Duplicate rows and stale cyclic parent links cannot repeat processes, include the root among its descendants, or overflow the argument stack during fail-fast process sampling.

## Alternatives considered

**Only catch initial provider calls.** Stream failures can occur during consumption, after the call has returned, so this leaves asynchronous errors unowned.

**Treat every gateway error as retryable.** This obscures terminal Host failures and can encourage replay of operations with side effects. Recovery is limited to the identified read carrier failure.

**Fail subprocess collection when persistence fails.** This discards useful bounded output and lets filesystem failures escape process teardown. Explicit incomplete-persistence metadata preserves the distinction for callers.

## Consequences

Failures remain visible through operation results without becoming unhandled rejections. Partial subprocess output carries an explicit persistence failure. Read recovery requires a user action after automatic retries are exhausted; it does not guarantee recovery from a continuing transport outage.

Focused provider, subprocess, JSON-RPC, and workspace-feed regressions cover error ownership, shutdown ordering, bounded output, and explicit retry coalescing. Host and client type checks and the official build validate integration.

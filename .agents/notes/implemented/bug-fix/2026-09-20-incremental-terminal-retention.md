# Agent Note: Backport incremental terminal retention

Status: implemented

English | [中文](2026-09-20-incremental-terminal-retention.zh.md)

## Problem

The terminal buffer appended each callback to one retained string, split it for the line cap, and rescanned it for the UTF-8 cap. Small callbacks repeatedly charged the entire retained window. This affected both persistent scrollback and active send output without changing their bounds.

## Decision

Adapt upstream `cea837e06525384855e3b8b8231c2400bc3cb85b` in the private buffer of [session.ts](../../../../packages/terminal/terminal-bash/src/session.ts), without migrating terminal ownership, sandboxing, or the sidebar. Track byte/newline totals over linked string chunks, coalesce small callbacks up to 4096 UTF-16 units, seal chunks without replacing lone surrogates, and copy an evicted prefix only after half its backing string is discarded. Pair adjacent surrogate halves consistently across chunks. Snapshot and consume still assemble retained text; consume resets its truncation latch and counters.

## Alternatives considered

- Keep rescanning the retained string: bounded memory does not bound cumulative append work.
- One node per callback: tiny writes would make metadata scale with callback count.
- Store encoded UTF-8 chunks: encoding changes lone-surrogate semantics.
- Import the whole terminal/sidebar migration or benchmark packaging: unnecessary for this private implementation fix and liable to disturb fork ownership contracts.

## Validation

[Buffer regressions](../../../../packages/terminal/terminal-bash/tests/session-buffer.spec.ts) compare public reads and send deltas with the eager reference, including the 4 MiB bound, line/byte caps, split Unicode, coalescing boundaries, and consume/reset. The deterministic accounting-work test appends 2000 32-character chunks and rejects repeated retained-history scans: the old implementation charges 64,032,000 character units against a 128,000-unit ceiling. This is an algorithmic negative control, not a measured real-shell latency claim. [Session regressions](../../../../packages/terminal/terminal-bash/tests/session.spec.ts) retain readiness, cancellation and teardown coverage.

## Consequences

Append accounting and eviction are amortized over incoming/discarded text. Reads still allocate and inspect the retained window; a read-heavy consumer can remain expensive. No tool schema, default limit, permission, or externally visible lifecycle changes.

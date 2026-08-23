# Agent Note: Adaptive history event windows

Status: implemented

English | [中文](2026-08-23-adaptive-history-event-windows.zh.md)

## Problem

The history API limits pages by visible messages, while persistence pages count raw session events. A streamed assistant response can place hundreds or thousands of chunk events between two visible messages. Reading `maxMessages` raw events at a time therefore turns one history page into many repeated scans, especially for sequential persistence media that must parse the complete artifact for each bounded read.

## Decision

`SessionPersistence.readTail(id, beforeSeq, limit, signal?)` returns at most `limit` valid events before an exclusive sequence position and reports whether older events remain. Its default implementation derives the page from `readFrom(id, 0)`, which gives every backend the operation without requiring a storage-specific implementation.

Detached `session.history` reads start with at least 256 raw events. If the window does not reach the oldest message group needed for the requested page, the API moves the cursor backward and doubles the next read limit up to 16,384 events. The visible-message quota and source-event grouping remain unchanged.

A tail that does not end at `turn/end` uses one keyed inspection so in-memory interruption recovery remains visible. A tail-page projection snapshot must end at the same event as the bounded history source; a stale or unavailable projection snapshot also uses one keyed inspection for the projection fold. Attached sessions continue to read their in-memory event arrays.

## Alternatives considered

**Use the visible-message limit as every raw-event read limit.** Rejected because streaming density is unrelated to message count and forces repeated scans through the same sequential artifact.

**Inspect every detached log once.** Rejected because it materializes and retains the complete event log even when the caller requests a small tail page.

**Use one fixed large event window.** Rejected because a size large enough for streaming-heavy histories over-reads ordinary histories, while any smaller fixed value still repeats scans for denser streams.

## Consequences

Ordinary detached pages usually complete in one 256-event read, while streaming-heavy pages widen geometrically instead of advancing by a message-sized raw window. Each read remains bounded by 16,384 returned events, but the default persistence implementation can still scan a complete sequential artifact. Storage-specific tail seeking can improve physical I/O later without changing the API proxy.

The response event range, `hasMore`, message quota, compaction source grouping, projection cut, and interruption-recovery behavior remain unchanged. Focused API-proxy tests pin the initial window, geometric widening, exact `beforeSeq` grouping, keyed projection fallback, and avoidance of corpus listing.

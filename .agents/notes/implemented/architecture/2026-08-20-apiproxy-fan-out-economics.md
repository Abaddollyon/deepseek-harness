# Agent Note: Fan-out economics for the session gateway

Status: implemented

English | [中文](2026-08-20-apiproxy-fan-out-economics.zh.md)

## Problem

Every open event stream installed its own `session/event` listener, and each listener recomputed the same work for the same event: it resolved the tool render view, built a frame, minted an rpcId, and handed it to a queue that the downlink then JSON-encoded. With S subscribers the host paid S× the projection and S× the encode for one session event — during streaming, once per chunk.

The queue itself was an array drained with `shift()`. Under any backlog — several sessions streaming into a socket that writes one frame per awaited completion — the drain degraded quadratically, and nothing dropped frames that a later frame had already made irrelevant: after a turn ended, its queued chunk frames were still delivered in full.

`session.list` computed each row from the session's events on every call, including a preset resolution that scanned the log backwards, so the list cost scaled with total history rather than with the number of rows.

`history` materialized the complete stored log to answer a page, and the subagent catalog recomputed per-branch running counts by walking every descendant chain per root.

## Decision

**One listener, one computation, one encoded frame.** The gateway installs a single process-wide `session/event` listener; the render view, the frame, its rpcId, and its encoded bytes are produced once per event and shared by every subscriber. The open-call table for result-view pairing is likewise process-wide, bounded by the largest live turn, and cleared at `turn/end`.

**A ring queue that can forget superseded frames.** `FrameQueue` keeps `buffer` plus a `head` index and compacts when `head * 2 >= buffer.length`, giving amortized O(1) pulls. An optional `FrameQueueCoalescer` declares, per frame, a `supersedingKey` and a `supersededKey`; a queued frame whose `supersededKey` matches an arriving frame's `supersedingKey` is replaced by a hole. That is what lets a turn ending drop the chunk frames still queued behind it, and what makes the unowned-jobs fan-out one frame instead of one per session.

**Rows from projections, presets memoized.** `sessionListFields` and `summarize` accept already-projected metadata and a resolved preset, and `presetForSession` memoizes the backward log scan in a `WeakMap<Session, { seq, value }>` keyed by the seq it was resolved at, so a row is recomputed only when the log actually moved past it.

**Detached history and cold snapshots.** `history` reads through the coordinator's `readTail`, and the response carries a `{ kind: 'detached' }` block — header, events, optional projections — so no caller holds a live log. `coldSnapshot` answers with an `asOfSeq` bound, and the subagent catalog computes branch counts in one postorder pass instead of walking each chain per root.

## Alternatives considered

**Cache the encoded frame lazily on first subscriber demand.** Rejected: the frame is produced on the emit path where the subscriber set is already known, so laziness buys nothing and adds a second state to reason about while the frame is in flight.

**Bound the queue by dropping the oldest frames under pressure.** Rejected: a dropped `session/event` frame is a hole in the client's window that only a full resync repairs. Coalescing drops exactly the frames a later frame makes irrelevant, which is a semantic rule the client can rely on, rather than a pressure heuristic it cannot.

**Push `session.list` pagination into this change.** Rejected as scope: pagination is a wire change that the client's list windowing has to land with, and it is tracked separately. Memoization gets the per-call cost off history size without moving the boundary.

## Consequences

Per-event host cost is now independent of the number of open streams; the queue is amortized O(1) and sheds superseded frames. A client that receives a coalesced stream sees fewer intermediate chunk frames after a turn ends — visible only as the transcript settling sooner, since the durable log is untouched. The preset memo is keyed by log seq, so a mutation that does not append cannot invalidate it; every current mutation appends. `history` responses are detached values, which is what allows the response to be encoded once and shared like any other frame.

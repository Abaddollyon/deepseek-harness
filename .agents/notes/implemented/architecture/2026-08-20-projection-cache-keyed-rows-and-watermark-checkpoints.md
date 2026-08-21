# Agent Note: Keyed projection-cache rows and watermark-gated checkpoints

Status: implemented

English | [中文](2026-08-20-projection-cache-keyed-rows-and-watermark-checkpoints.zh.md)

## Problem

The projection cache persisted as one document. Every checkpoint rewrote the whole thing, so the write cost scaled with the corpus rather than with the session that changed — the measured deployment carried a 1.6 MB document that one turn ending was enough to rewrite.

The dirty accounting counted the wrong thing. Every *committed event* advanced the counter, so a streaming turn armed checkpoint after checkpoint for events that moved no projection at all; the count and interval throttles existed to damp a signal that should not have fired.

Worst, the mid-stream checkpoint path took a durability barrier: it snapshotted the registry cut and then flushed the session log before writing the cache row, so that a crash could leave the cache behind the log but never ahead of it. Flushing the log is exactly the blocking work a streaming turn must not do, and it ran on the hot path.

## Decision

**Keyed rows in SQLite.** The cache composes onto the SQLite store with one row per session, so a checkpoint writes only the session that moved.

**Count projection movement, not events.** The per-session state tracks `lastChangedSeq`, the last projection change sequence counted for that session, and the registry's per-unit change signal is de-duplicated by sequence (one event can move several units). Only a projection state-reference change makes a checkpoint fresher, so the throttles now damp a signal that means something.

**No mid-stream flush.** `checkpoint` writes the cache row without forcing the log's write-behind drain, and the invariant is inverted deliberately: the cache may briefly *lead* the stored log, and `coldSnapshot` detects an overreaching row and replays from seq 0. The mandatory points (`turn/end`, detach) keep their ordering; only the mid-stream path trades a barrier for a cheap recovery.

## Alternatives considered

**Shard the document by session prefix instead of moving to SQLite.** Rejected: sharding picks a fan-out constant that is wrong for both small and large corpora, and it reimplements keyed storage badly. The SQLite store already owns keyed durable rows, and composing onto it kept the cache a consumer rather than a second storage engine.

**Keep the flush barrier and make it asynchronous.** Rejected: an asynchronous barrier is not a barrier. Either the write waits — the cost being removed — or the ordering guarantee is gone, in which case the honest design is to state that the cache may lead and to handle it on read, which is what `coldSnapshot`'s replay does.

**Detect an overreaching row by comparing against the log tail on write.** Rejected: that is the flush in another costume, since knowing the durable tail means waiting for it.

## Consequences

A checkpoint's cost is now proportional to one session. A crash can leave a cache row ahead of the stored log; the cold read detects it and replays from seq 0, which is a slower cold path in exchange for never blocking a streaming turn — and the replay is correctness-preserving, where the previous design's cost was unconditional. The mandatory checkpoint points are unchanged, so the durable value most reads want (the turn-final one) still lands at `turn/end`.

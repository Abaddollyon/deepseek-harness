# Agent Note: Session control queue projection coalescing

Status: implemented

English | [中文](2026-08-30-control-queue-projection-coalescing.zh.md)

## Problem

Each control generation queues broadcast frames per consumer until that consumer drains them. On a busy host — a long synchronous query, a stalled tab — the projection units recomputed per committed event (token-meter's usage, pressure, and breakdown, plus the list-metadata unit) out-produce every other control traffic, so a behind consumer's queue filled with projection frames whose only client-side fate was discard: the client projection store applies frames higher-seq-wins (`seq <= current ? ignore : replace`), making every queued frame but the newest per `(session, key)` pure delivery cost. Fan-out memory, drain, and serialization per event scaled with consumer count even when those consumers were not keeping up. The control-stream vocabulary this extends lives in [the Session history and event transport note](2026-08-18-session-history-and-event-transport.md).

## Decision

**Each per-consumer control queue physically unlinks superseded keyed nodes; only `projection` frames carry an identity.** A push maps its frame through `controlSupersedingKey` (`packages/api/session-controller/src/control.ts`), the sole owner of the safety judgement. The queue stores nodes in a doubly linked list and indexes undelivered keyed nodes in nested maps by Session id and projection key. A newer frame for the same tuple unlinks the older node in O(1), immediately releasing both its frame and queue position without moving any surviving node. Distinct tuples cannot collide even when either component contains NUL. The drain visits only deliverable nodes, deletes each surviving node's map entry on delivery, and `end()` clears the index. Non-projection frames are never coalesced, reordered, or dropped.

**The judgement admits exactly one frame kind.** `projection` qualifies because it carries a unit's COMPLETE finished value plus the watermark seq it was computed at: a frame a newer one overtook inside the queue is precisely a frame the client's higher-seq-wins rule would discard on arrival, so dropping it changes no observable state. It is also the only kind with the volume to matter. `queue` and `jobs` frames are whole-snapshot last-wins values that would be sound to coalesce but fire on rare user or registry actions, so there is nothing to save, and collapsing a job's `running -> stopping -> killed` push run would cost a visible transition. `baseline` never enters the queue: each generation yields it directly.

**An opt-in benchmark prices the fan-out.** `apps/web/tests/host-control-fanout.perf.ts` (manual `test:web:perf` lane, checked in the host compiler face) seeds a ~1,560-session catalog and a ~1,724-event conversation, then brackets every queue-policy effect between a `blocked` burst (no drain between appends) and a `paced` one (a drain after every committed event) across 0–8 SessionControlController consumers. It reports measurements without timing assertions — host speed is not a correctness contract — while structural assertions pin the delivered state: every consumer opens exactly one catalog-wide baseline, never loses the latest value or seq per key, never sees a seq regression, and receives a stream identical to every other consumer's. Paced delivery equals the live push census; blocked delivery is exactly the newest frame per key.

## Alternatives considered

**Coalesce queue and jobs frames too.** Rejected: both fire per user or registry action rather than per event, so there were no frames to save, while a collapsed `running -> stopping -> killed` run would hide a transition the jobs panel renders. `controlSupersedingKey` documents the exclusion so a future high-rate kind is admitted deliberately, not by default.

**Leave an empty slot in an array buffer.** Rejected: it releases the superseded frame but retains one tombstone per push, so a stalled consumer's physical queue cardinality remains linear in burst size and its eventual drain scans every supersession. Linked nodes make removal constant-time while preserving the relative order of all surviving frames.

**Keep dropping on the client only.** Rejected: the host pays per-consumer queue memory, drain, and serialization for frames the client discards on arrival — the benchmark's blocked rows show ~1,050 pushed frames per burst collapsing to 4 delivered per consumer, so the saving is the common case under load, not an edge.

## Consequences

A stalled or slow consumer no longer multiplies projection queue size or delivery cost: physical keyed-node cardinality and blocked-mode delivery remain constant per `(session, key)` instead of growing with burst size, and drain work excludes superseded nodes. Queue and jobs frames arrive in push order with no loss; abort still drops the buffer; host teardown still flushes the surviving newest frames; the per-generation baseline contract is unchanged. The client needs no change — its higher-seq-wins rule already treats a never-delivered stale frame and a discarded one identically, and every projection consumer converges to the same newest value per key.

## Verification

`control-coalescing.host.spec.ts` stress-checks physical queue cardinality across 100,000 pushes, collision-shaped Session/key tuples containing NUL, blocked coalescing to the newest value per key, monotonic seqs across blocked batches, no coalescing across sessions, queue-frame order and completeness beside coalesced projections, supersession landing between wake and drain, abort dropping the buffer, and teardown flushing only the newest buffered frame. `session-projections.host.spec.ts` keeps the paced per-unit push contract with a drain between appends. The benchmark asserts every consumer's delivery against a live registry push census in both cadence modes and runs in the host compiler face.

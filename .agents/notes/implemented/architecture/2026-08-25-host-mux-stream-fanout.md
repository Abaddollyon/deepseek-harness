# Agent Note: Host mux streaming — one fan-out listener and superseded projection frames

Status: implemented

English | [中文](2026-08-25-host-mux-stream-fanout.zh.md)

## Problem

Every open mux stream installed its own `ctx.on('session/event')` listener, and each listener re-derived the same frame for the same event: it maintained a private open-call table, resolved the presenter scope through `ctx.agents`, ran `viewFor`, and minted its own envelope. The work was therefore multiplied by the number of connected consumers — two browser tabs on one host paid for every session event twice, eight paid eight times — even though all of them received identical content.

Separately, the mux queue was an unbounded FIFO with no drop policy, so a consumer that had not drained still received every intermediate value of a whole-value push frame.

`apps/web/tests/host-fanout.perf.ts` (perf lane, `pnpm run test:web:perf`) prices both against the real deployment's cardinality — 1,561 sessions, one conversation grown past 1,724 events, a 1,320-event burst, and 1/2/4/8 concurrent mux streams. Before the change, fan-out cost past the bare `session.append` baseline scaled linearly with stream count:

| streams | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| fan-out ms per 1,320-event burst | 51 | 90 | 170 | 348 |

A CPU profile of the 8-stream burst attributed 106ms of 354ms to the Cordis Context property proxy reached directly from the per-stream listener body — the eager `ctx.agents.get(session.id)` argument — and a further 26ms to the same proxy inside `viewFor`. Three quarters of those lookups were waste even once: only `tool/call` and `tool/result` can carry a view, and the scope was resolved for every event type.

The frame census exposed the second cost. Per stream, that 1,320-event burst delivered 1,520 `session/projection` frames — more frames than there were events, because the token-meter units recompute on nearly every event.

## Decision

**One process-wide `session/event` listener.** The open-call table, the view computation, and the envelope mint move to gateway scope; the listener pushes one shared envelope to every queue in `muxQueues`, which is what `broadcast` already did for every other push frame. Sharing the envelope is safe because a mux consumer reads `rpcId` only on answerable frames, and those mint their own stable ids in the pending registries. Streams keep their own `session/created` and job listeners; those are per-stream baselines, not per-event work.

The table is now warm from gateway start instead of empty at each stream open, so a stream opened mid-turn resolves a result's call pairing from the table rather than the backscan fallback. Both routes return the same pairing.

**Lazy presenter scope.** `viewFor` takes `scopeFor: () => ScopeKey | undefined` instead of a resolved `ScopeKey`, matching the `argsFor` parameter beside it. The agent lookup now happens only for the two event types that can produce a view.

**Superseding-key coalescing in `FrameQueue`.** A queue may be constructed with a key function. While an undelivered frame with that key is still buffered, a newer one empties the older slot in place, so the older frame is never delivered; emptying rather than splicing keeps every other frame's queue position and therefore every cross-key ordering. `muxSupersedingKey` is the single owner of which kinds qualify, and it keys **only** `session/projection`.

## Why only `session/projection`

A frame may be dropped only when a later frame reconstructs everything it carried. `session/projection` meets that on both counts that matter. It carries one unit's complete finished value plus the watermark `seq` it was computed at, and the client's projection store applies it as `seq <= current ? ignore : replace` — so a frame overtaken inside this queue is exactly a frame the client would itself have discarded on arrival. It is also the only kind with the volume to justify the mechanism.

Every other kind is unkeyed. `session/event` is a unique durable log entry and dropping one opens a seq gap. `session/subscribed` is a per-generation re-baseline whose `lastSeq` gates the frames around it. `approval/requested` and `question/requested` are the only copy of a prompt the user must answer, and each `approval/resolved` / `question/resolved` settles one distinct pending item.

`session/queue` and `session/jobs` would have been sound — both are documented whole-snapshot frames that clients replace rather than accumulate, and the client's own pre-instantiation buffer already compacts `session/queue` by session. They are still excluded, because the benchmark measured **zero** frames of either kind to save: both fire on rare user or registry actions, not per event. Coalescing them would have collapsed a job's `running -> stopping -> killed` push run into `killed` alone, costing a visible transition in exchange for nothing measurable.

## Testing

`api-proxy-projections.spec.ts` gains three cases: undelivered frames collapse to one surviving frame per key carrying the final value at the final seq; keys never merge across sessions or across units; and every `session/event` still arrives with contiguous seqs while the projections beside them coalesce. The existing per-unit broadcast case now drains between appends, which is the cadence a live agent loop produces and the cadence its contract was written for; the two `session/jobs` lifecycle cases pass unmodified, which is the direct evidence that job transitions were left alone.

Live-delivery correctness is unchanged: `session/event` frames are never keyed, so the errored-window reopen of [live event window recovery](../bug-fix/2026-08-25-live-event-window-recovery.md) still sees every live frame.

Measured after, same benchmark and machine:

| | before | after |
|---|---|---|
| fan-out ms, 8 streams, 1,320-event burst | 348 | ~24 (no longer scales with stream count) |
| frames delivered, 8 streams, paced | 22,720 | 13,760 |
| frames delivered, 8 streams, blocked event loop | 22,720 | 10,576 |
| frame bytes, 8 streams, paced | 7,517 KB | 5,854 KB |
| frame serialization ms, 8 streams, paced | 73.4 | 35.8 |

The `paced` row yields to the macrotask queue after every turn, which is how a live agent loop appends; `blocked` appends the whole burst synchronously, which is what a busy host event loop produces. The two bracket what any queue policy can save, and coalescing removes 74% of projection frames even in the paced case, because one turn's events recompute the same units several times before the stream drains.

## Alternatives considered

**Memoize `resolveSessionPreset` per session.** Rejected on measurement, and the benchmark keeps a standing case for it. Resolution costs 15µs over the real machine's largest log (1,727 events, the worst case: a full backward scan) and 0.07µs over an ordinary one; one whole-catalog `session.list` over 1,562 sessions costs ~64ms, of which resolution is 0.12ms — **0.19%**. It appears nowhere on the mux hot path. A per-session memo would also have to invalidate on `agent-preset/selected`, the very event the function exists to observe, so it would buy a fifth of a percent in exchange for a stale-composition hazard.

**Hoist the per-stream `session/created` and job listeners too.** They run once per session creation or registry commit, not per event, and the job listeners close over a `ctx.get('jobs')` read taken at stream open so a stream opened after the jobs service is composed still sees it. Hoisting would have frozen that read at gateway construction for no measured gain.

**Cache the `ctx.agents` service reference to skip the Context proxy.** The property proxy is topology-sensitive and a cached reference would survive recomposition. Making the lookup lazy removes three quarters of the calls without touching resolution semantics.

**Bound the queue and drop under pressure.** A byte or length bound needs a policy for what to drop, and the only frames safe to drop are the ones the superseding key already removes. A bound that dropped `session/event` would convert a visible failure into a silent one.

## Consequences

Per-event host cost is now independent of how many consumers are connected: opening a second tab no longer doubles the gateway's work per session event. What still scales with stream count is per-stream serialization in the SSE handler and the per-stream subscription baseline (1,561 `session/subscribed` frames per open, ~16ms), both inherent to having N clients.

Coalescing is a real behavior change, not a pure optimization: a client no longer observes intermediate projection values that were superseded before delivery. It ends in the same state, since the store discards lower seqs regardless, but a consumer that wanted the full value history off the wire cannot get it here. Anything needing that history needs a durable event, which the [projection design](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md) already requires of model-visible facts.

The measured costs this branch does not address are the per-stream subscription baseline and the host content search reported by [session list load performance](../bug-fix/2026-08-25-session-list-load-performance.md).

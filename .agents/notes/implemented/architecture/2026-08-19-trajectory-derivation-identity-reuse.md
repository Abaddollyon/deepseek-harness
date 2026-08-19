# Agent Note: Trajectory derivations reuse identity instead of rebuilding the session

Status: implemented

English | [中文](2026-08-19-trajectory-derivation-identity-reuse.zh.md)

## Problem

Every streaming chunk rebuilt the whole Trajectory read model, so the main thread capped at about 29 chunks per second on a long session.

`TrajectorySnapshotBuilder.apply()` always ran a full `snapshot()`: it walked every contribution, sorted requests and finalized nodes, and returned fresh `eventNodes`, `eventLocations`, `requests`, `callSchemas`, and `runningCalls` identities. Content had not moved — an `assistant/chunk` only advances the in-flight partial — but React saw new objects, so `TrajectoryView`'s finalized memo re-ran `deriveTrajectoryLayout`, which re-ran the seven derived passes in `TrajectoryTable`.

`deriveTrajectoryLayout` had no incrementality of its own. It re-indexed results, emitted call ids, and following assistants over every node, re-sorted every layout entry, and allocated a new `TrajectoryCellProps` per record, so no cell survived a render either.

Measured on the largest session on disk — 93,230 raw events reconstructed into 6,438 conversation nodes and 5,680 trajectory cells — the pipeline cost 34.5 ms of pure JS per chunk: 29.3 ms in `deriveTrajectoryLayout` and the rest in the table's derived passes. Two further leaks rode along: the timeline model was projected twice per frame whenever a range was selected, and live search rescanned every cell of the session on every token.

## Decision

**Both derivations publish by folding onto their previous result.** A derivation is still whole — the builder walks every contribution and the layout walks every entry — but what it publishes reuses the previous identity wherever the content did not move. Identity, not recomputation, is what downstream memos read, so this is where the cost actually lives.

**`TrajectorySnapshotBuilder` folds each snapshot onto the last published one.** `publish()` rewrites every equivalent array member and map value to the previously published one, returns the previous container when nothing in it moved, and returns the previous snapshot object when no section moved at all. `packages/client/ui-trajectory/src/client/derived-identity.ts` owns the fold: `isEquivalent` descends arrays and plain objects and compares anything else by identity, because a derivation that rebuilds a Map rebuilds its members too. The helpers adopt the fresh containers and rewrite them in place, so a value that passed through them is read-only for every caller.

This is deliberately verify-then-reuse rather than patch-in-place: the snapshot is still built from the contributions on every flush, so no incremental path can drift from the authoritative walk. A chunk that only advances the partial costs 0.77 ms and leaves every finalized section identical.

**`deriveTrajectoryLayout` takes an optional per-view cache.** `createTrajectoryLayoutCache()` returns the memo one mounted `TrajectoryView` passes to every derivation it makes; `TrajectoryView` holds it in `useState` so it lives and dies with the view. The cache carries four independent memos:

- **Per-record expansion.** `laidFor` keys a record's cells on the input object that produced them — the node, the request, or the prompt change — and validates a hit against the record's start index, its declared dependencies, and the tool schema every produced cell read. An assistant's dependencies are the preceding wall time plus, per tool-call block, the result, the call start, and the call block. A hit returns the previous `LaidCell` objects, so the cells keep identity; a miss re-expands and re-attaches schemas.
- **Node-derived indexes.** `nodeIndexesFor` extends the previous derivation's layout entries, result index, call starts, emitted call ids, following assistants, and represented steps in place when the new `nodes` array starts with exactly the previous members, and rebuilds otherwise. Appending extends the tail; loading an earlier page rebuilds.
- **Per-turn model.** `turnModelFor` reuses a turn's model when its groups hold the same titles and the same cell objects, which skips the group wall-span description and keeps the model identity a memoized `TrajectoryTable` reads.
- **The result array.** A derivation whose turn models are all reused republishes the previous array, so an input that moved nothing cannot invalidate a downstream memo.

**A cache is never load-bearing for correctness.** `deriveTrajectoryLayout(input)` without one expands every record again, and the two paths differ only in identity. That reference path is what the equivalence tests compare against, which is why the cache can be unconditional rather than sitting behind a switch.

**Tool schemas attach at expansion.** The trailing loop that walked every group and re-ran `JSON.stringify(schema, null, 2)` per cell is gone; `attachSchemas` runs inside the memo boundary, the serialized text is memoized per schema object, and the schema each cell read is part of the cache key, so a schema arriving later re-expands its cell instead of mutating one an earlier render already published.

**The timeline model is derived once per frame.** `TrajectoryView` derives it and passes it to `TrajectoryTimeline` as an owner prop; `trajectoryTimelineFocusIndexes` now takes the model rather than the layout and mode. `deriveTimedTimeline` computes its domain bounds with loops instead of `Math.min(...spans)`, which one turn holding a long session's cells would overflow.

**Live search splits its match set by layout.** The finalized index set is its own memo keyed on the finalized fold, the in-flight set is a second memo, and the union is skipped entirely when the partial matched nothing. A streaming token therefore rescans only the in-flight tail.

## Measured effect

The same session, medians of seven runs under Node 25.9.0, comparing this code against `HEAD`:

| Path | Before | After |
|---|---|---|
| `apply()` for one streaming chunk | 1.12 ms | 0.77 ms |
| `deriveTrajectoryLayout` | 29.3 ms | 5.8 ms with one appended node |
| Full pipeline (layout + the table's five derived passes) | 34.5 ms | 13.5 ms with one appended node |
| Chunk that appends no finalized node | 34.5 ms | 0.77 ms — every downstream memo holds |

68,995 of the measured session's 93,230 events are assistant or tool-call content chunks, which move only the in-flight partial; those take the 0.77 ms row. The events that add a finalized node, open a step, or move a running call — assistant messages, tool results, step starts, and code dispatches, about a quarter of the log — take the append row.

## Alternatives considered

**Patch the snapshot in place on the non-structural path.** The audit proposed replacing the single changed `finalized[i]` / `requests[i]` slot and skipping the sorts. It saves the 0.7 ms walk, but the walk was never the cost — the identity churn it published was — and a patch path that can disagree with the authoritative fold is exactly the failure that is hardest to test. Folding after a full build buys the same downstream effect with no second source of truth.

**Resume the layout fold from a checkpoint.** Snapshotting the fold state at a turn boundary and replaying only the tail would cut the residual per-append cost further. It is unsound without proving that no later input can reach a checkpointed record, and later inputs demonstrably do: a tool result changes an earlier assistant's tool cell, and a trailing user message is re-placed when its assistant arrives. Dependency-tracked memoization states those relationships explicitly instead of assuming them.

**Gate the incremental path behind a config field.** Client plugins receive no configuration: the boot graph carries `id`/`url`/`rev`/`inject`/`immediately`, and the shell creates each entry with `loader.create({ name })`, so a browser-half `Config` export would never be read. A switch would have to be a module constant, which is not configurability. The equivalence tests make the switch unnecessary.

**Keep the timeline model inside `TrajectoryTimeline` and memoize harder.** The second derivation lives in a different component's memo (`trajectoryTimelineFocusIndexes`), so no amount of memoization inside the timeline removes it. Lifting the model to the one owner that has both consumers is the only place the duplicate disappears.

**Restructure `TrajectoryTable` in the same change.** Its five derived passes are 7.7 ms of the remaining append-chunk cost. They are already free on the 93 % of chunks that append nothing, and cutting them further means extracting a memoized row component out of a 3,074-line body — a separate change with its own risk, not a rider on this one.

## Consequences

Cells, turn models, snapshot sections, and the layout result array are now shared across renders. Nothing may mutate a value these derivations returned; the schema attachment that used to do so moved inside the cache boundary for exactly that reason, and `derived-identity.ts` states the obligation on its helpers.

`TrajectoryTimelineProps` gains a required `model`, so every render site supplies it. `trajectoryTimelineFocusIndexes` takes a model instead of `turns` and `mode`.

The append path still costs 5.8 ms of layout plus 7.7 ms of table passes on a 6,438-node session. Loading an earlier page rebuilds every index and re-expands every record, which is correct and no slower than before.

## Testing

`tests/layout.client.spec.tsx` derives with and without a cache at every point of an append sequence and asserts the two are equal, so a divergence fails loudly; further cases pin that an appended event keeps the identity of untouched cells and turn models, that a late tool result re-expands exactly the record it moved, that a late tool schema re-expands its cell, that an unmoved input republishes the same array, and that prepended history rebuilds correctly. `tests/snapshot-builder.client.spec.ts` pins that a chunk advancing only the partial republishes every finalized section unchanged, that an upsert moving nothing republishes the same snapshot object, and that appending one event keeps every prior node's identity.

## Related

[Trajectory assembly from registered Conversation Contexts](2026-08-11-trajectory-conversation-context-assembly.md) owns how contributions reach the builder; this note owns what the builder and the layout publish from them.

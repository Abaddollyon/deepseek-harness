# Agent Note: Deriving a trajectory by advancing it, not rebuilding it

Status: implemented

English | [中文](2026-08-20-trajectory-incremental-derivation.zh.md)

## Problem

Trajectory recomputed its whole pipeline on every event. The snapshot builder rebuilt all records and re-sorted them; layout recomputed every span; the tool tree re-projected every node; the timeline created a DOM span per record; and the virtual-row table rebuilt its rows and groups.

For a live session this is the worst possible shape: the input grows monotonically at the tail, and every append re-derived the prefix that could not have changed.

## Decision

**Maintain the snapshot in sections and append monotonically.** The builder classifies each operation and tracks affected sections as a bitmask, keeping maps and indexes across updates. A monotonic append extends the order without sorting; only a structural change falls back to a full rebuild. Sections the operation did not touch keep their identity, so downstream memoization holds.

**Accept a layout prefix.** Layout keeps its caches in WeakMaps and records an accepted-prefix bound. A fast path validates the prefix by identity, patches the active assistant and tool-result spans, and extends the accepted index — so a streaming turn touches its own tail rather than the timeline.

**Reproject only ancestors in the tool tree.** The tool definition holds calls, children, parents and projected maps, invalidates ancestors only, caches each projection under a source-plus-interruption key, and bounds traversal with a cycle guard at depth 256.

**Bin the timeline by pixel.** Spans are grouped into a `lane:column` map so the rendered DOM is bounded by the pixel width of the viewport rather than by record count; details are computed for the individual span under the pointer and cached in a WeakMap.

**Keep the table's tail append-stable.** The virtual-row cache patches the final row and its suffix, retaining and regrouping the suffix under an explicit eligibility test, and rebuilds only for a prepend or a reorder.

## Alternatives considered

**Memoize the whole snapshot on the event window identity.** Rejected: the window changes on every append, so the memo never hits during exactly the workload that matters.

**Sort after each append.** Rejected: appends arrive in seq order, so the sort is provably unnecessary; the builder asserts monotonicity and falls back to a rebuild when it does not hold, rather than paying the sort to be safe.

**Cap the timeline's rendered spans.** Rejected: a cap makes the timeline lie about what happened. Pixel binning renders every record's contribution while bounding the DOM by what a screen can actually distinguish.

**Invalidate the whole tool projection on any change.** Rejected: a nested subagent tree is the case this view exists for, and whole-tree invalidation makes its cost quadratic in depth × updates.

## Consequences

Each stage now advances rather than rebuilds, but the bounds are honest rather than absolute, and the caveats are worth stating because a later reader will otherwise assume more than shipped: layout's prefix validation remains O(prefix) even on the fast path; the timeline still iterates the visible spans, only its DOM is pixel-bounded; and the table's tail path rebuilds global indexes, so a strict O(suffix) total is **not** claimed. A structural snapshot change — anything that is not a monotonic append — still takes the full rebuild, which is the correct floor rather than a gap.

The tool projection cache is keyed by source plus interruption state, so an interrupted call reprojects rather than serving a stale settled shape. The traversal bound of 256 is a guard against a malformed tree, not a supported depth.

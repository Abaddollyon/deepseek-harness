# Agent Note: What the browser pays per session it is not looking at

Status: implemented

English | [中文](2026-08-20-client-runtime-multi-session-economics.zh.md)

## Problem

The object layer charged the viewer for every session on the host, not for the one on screen.

Each projection write called `markDirty` synchronously, so a projection storm published one consumer update per projection rather than one per frame. Every session's `session/event` was folded into its conversation whether or not anyone could see it: with several sessions streaming, the tab paid the fold, the snapshot rebuild, and the React work for windows nobody was looking at.

Nothing was ever released. Subagent catalogs and per-session derived state accumulated for the whole tab lifetime. The list snapshot rebuilt its record map wholesale (`Object.fromEntries` over the world), so every list change invalidated the identity of every row's input and re-rendered the sidebar entire.

Cold start was serialized behind evidence it did not need: the first paint waited on reads whose answers it could infer, and an empty subagent catalog was re-fetched on every open.

The connection's frame inbox dequeued with `shift()`, so a queued burst degraded quadratically at exactly the moment — reconnect, first load — when the burst is largest.

## Decision

**Publish streaming state once per frame.** The projection store's `subscribeAny` and the jobs path route through `notifier.markFrameDirty`, whose rAF batching collapses a storm into one publication; the projection path now only applies the store. A test drives 100 frames' worth of writes and asserts one notification.

**Fold only what is watched.** Selecting a session suspends the previous one and resumes the selected; an inactive session's `session/event` suspends and returns the pre-fold state instead of folding. `Session.conversationStale` records that its window fell behind, and resuming resyncs through the existing tail-repull path rather than replaying — deliberately, so the UI never shows a loading flash for a session the user just came back to. Reconnect resyncs the selected session only.

**Release what is not live.** `pruneRetainedState` walks live and protected sets, and a `catalogAccess` clock bounds retained subagent catalogs at `MAX_RETAINED_CATALOGS = 128`; pruning runs after the baseline lands.

**Keep list identities stable.** `stableRecordMirror` and the cached record mirrors preserve both the map and the snapshot identity across a change that did not touch a row, so the sidebar's memoized rows keep their inputs.

**Decouple cold start, and shortcut what is known empty.** `freshEmpty`/`nonEmptyEvidence` sets drive a `knownEmpty` shortcut so `refreshSubagentsForOpen` skips only a catalog proven empty; evidence from list, subscribe, event, and status invalidates it, and a disconnect clears it.

Two corrections belong to the record because both are the kind of bug this class of optimization invites:

- **The projections baseline must not be a seed.** A partial list block applies only the keys it provides, so an absent key does not clear an existing value and a stale block cannot overwrite a fresher one. `knownEmpty` shortcuts the *catalog* only — `Session.open` still history-fetches, so values like image limits are never skipped.
- **A reload must be allowed to win.** `startInitialSelection` waits when the session phase is still pending and the target workspace already has membership, because — as the code says — "a non-empty workspace membership is evidence that an existing session may be restored; wait for its rows before allowing a create." Without the guard the shortcut raced a reload and created a new session over a restorable one.

**An indexed deque for the frame inbox**, with a head index and threshold compaction, replaces `shift()`.

## Alternatives considered

**Replay an inactive session's buffered events on resume.** Rejected: the buffer is unbounded in the only case that matters (a long absence), and the tail repull is one bounded request that also repairs any gap the absence introduced.

**Seed absent projection keys from the list block.** Rejected explicitly in the code: treating a partial block as a complete seed lets an older response clear a newer value, which is a data-loss bug wearing an optimization's clothes.

**Drop the `knownEmpty` shortcut once the reload race appeared.** Rejected: the race was in the selection sequencing, not in the shortcut, and the guard names the evidence it waits for rather than adding a delay.

## Consequences

Per-frame cost is now proportional to the session on screen. An inactive session's UI is stale until it resumes — acceptable because it is not rendered, and resolved by the resync on resume. Retention is bounded at 128 catalogs, though protected and in-flight entries can hold the count above the target briefly. The rAF batching means a consumer sees streaming state at frame cadence rather than per write, which is the intended contract of `markFrameDirty` and is asserted directly by test.

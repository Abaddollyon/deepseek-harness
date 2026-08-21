# Agent Note: Three render-path wins — stable subscriptions, streaming checkpoints, flow reuse

Status: implemented

English | [中文](2026-08-20-stable-subscriptions-streaming-checkpoints-and-flow-reuse.zh.md)

## Problem

Three independent hot paths shared one shape: each rebuilt, on every update, something whose input had not changed.

**The slot renderer resubscribed on every render.** `SlotOutlet` and `RootOutlet` passed inline closures to `useSyncExternalStore`. A fresh closure per render is a fresh subscription identity, so React churned one unsubscribe/resubscribe per outlet per render — paid across every outlet in the tree, on every render, forever.

**Streaming markdown re-parsed its unstable tail.** Each arriving chunk re-parsed a growing suffix whose grammar was not yet settled, so the parse cost grew with the message while the message grew: quadratic in the length of a streaming reply.

**The AgentFlow model rebuilt wholesale and joined children by scan.** Each child looked up its source with `sources.find`, which is quadratic across a wide fan-out — precisely the shape a swarm produces — and the whole model was recomputed rather than advanced.

## Decision

**Cache the subscription pair per host and key.** `keySubscriptionCache` is a `WeakMap<host, Map<key, KeySubscription>>`; both outlets read their pair from it, so the subscribe and `getSnapshot` functions keep their identity across renders and React keeps the subscription.

**Checkpoint the parse and render the unsettled tail as text.** The incremental parser takes 8 KiB checkpoints with UTF-8 accounting, keeps a `checkpointTail`, and emits the latest suffix as a `plainTextBlock` — the code states plainly that the newest suffix "renders as plain text" until a checkpoint or settlement covers it. `settle()` performs the full parse and verifies it against a sampled prefix, so the settled DOM is exactly what a non-incremental parse would have produced.

**Advance the flow model instead of rebuilding it.** `AgentFlowView` retains a builder across renders; the builder keeps lineage selection, a row memo, validated address reads, and a gate on the descendant/token aggregate, and the child join uses a `Map` instead of `find`. A collapsed subtree still contributes its aggregates without materializing visible rows. The one-shot build remains as a thin wrapper, so callers that want a single snapshot are unchanged.

## Alternatives considered

**Memoize the outlet closures with `useCallback`.** Rejected: the identity must be stable per *host and key*, not per component instance — sibling outlets on the same key should share one subscription, and a component that remounts should not orphan it. The WeakMap keys on the host, so the cache dies with it.

**Parse only on settlement and show raw text while streaming.** Rejected: it makes every streaming reply unformatted for its whole life, which is a visible regression traded for a cost that checkpoints already bound.

**Re-parse from the last block boundary instead of a byte checkpoint.** Rejected: a block boundary is not known until the grammar settles, which is the thing being deferred; a byte checkpoint with UTF-8 accounting is a bound the parser can take without understanding what follows.

**Keep the wholesale AgentFlow build and memoize its result.** Rejected: memoizing a wholesale build still pays the build whenever any input moves, which for a live swarm is continuously.

## Consequences

Outlet subscriptions are now stable for the life of their host, and the inner key namespace is bounded by the slots a host declares. A streaming message may render its newest suffix as plain text until the next checkpoint, after which formatting appears — and the settled DOM is verified to match a full parse, so nothing is lost at the end. The flow builder is cached per view and depends on reference-stable lineage, which the runtime's identity work supplies; its address reads are validated rather than assumed. A new spec covers the wide fan-out, deep chain, collapsed subtree, fast-path/address, and row-transition cases that the scan-based join used to fail on.

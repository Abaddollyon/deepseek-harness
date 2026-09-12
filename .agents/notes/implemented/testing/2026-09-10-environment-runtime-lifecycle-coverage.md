# Agent Note: Environment runtime lifecycle coverage

Status: implemented

English | [中文](2026-09-10-environment-runtime-lifecycle-coverage.zh.md)

## Problem

Environment runtime coverage must distinguish reachable cancellation, service withdrawal, storage limits, and activation failures from branches that contradict private ownership. Tests that invent impossible same-process values obscure those obligations instead of verifying them.

## Decision

The [environment runtime tests](../../../../packages/client/environment-runtime/tests/) drive acquisition, generation changes, navigation supersession, effect disposal, and persisted JSON through the owning implementations. The [navigation component tests](../../../../packages/client/ui-environment-navigation/tests/) verify Host-qualified sidebar modes, overview rendering, and Activity cleanup without changing product presentation.

Private branches with a locally established invariant are omitted:

- Request parsing strips the query or fragment with string replacement, without an array-element fallback. Escaping, normalization, traversal, and route-authorization checks remain.
- A presentation map above its 200-entry cap has an oldest key. Eviction removes that key rather than retaining an impossible empty-map exit.
- A registry entry remains mapped until its first disposal starts. Repeated disposal joins its existing promise; creation-failure cleanup still checks entry identity because concurrent rejected acquisitions can share that failure.
- A dirty persistence snapshot has a scheduled timer. Flushing clears it, clears dirty state, and drops the handle; disposal does not repeat that cleanup.
- An idle projection has already retired its remote mount, so local admission needs no separate mount-identity check. Admission still requires the idle phase because synchronous navigation subscribers can redirect a local request to a remote destination.
- An activation error is not published alongside a mounted presentation; failed acquisition removes the mount before publishing the error state.
- The Session location follower subscribes to and reads one captured list store. The Sessions service owns that readonly store for its lifetime; its snapshot cannot disappear between subscription and notification.
- The composition service admits one startup and one active owner at a time. Its completion and release clear their slots directly. Feature transport receives the environment id already bound by the request owner.
- Both private signal-composition callers supply a mandatory lifetime signal. There is no zero-signal result or fallback lifetime.

Presentation identity remains an independent final check: retry can replace the UI mount while preserving navigation and the connected Host generation. A callback result requires a ready projection and the same presentation object. Disconnect retains the mount, but the generation check rejects stale work. Copied observer notifications and failed superseded cleanup can run after cancellation or withdrawal, so their settlement and identity guards remain.

## Alternatives considered

Coverage exclusions would hide reachable lifecycle failures. Fabricating empty maps, missing split results, or a mismatched injected carrier id would test values the private implementation cannot produce. Retaining those branches offers no additional protection for callers.

## Consequences

Coverage exercises observable teardown, retained state, cancellation, and transport behavior. Bounds and parser checks remain intact, and no coverage threshold changes. Future changes that allow overlapping composition owners or zero lifetime signals must revisit the corresponding private invariants rather than adding tests for an unsupported state.

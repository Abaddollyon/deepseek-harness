# Agent Note: Session list load — measured costs and the two fixes that paid

Status: implemented

English | [中文](2026-08-25-session-list-load-performance.zh.md)

## Problem

A corpus of ~1,560 sessions (one Workspace holding ~678) made the Web GUI's
sidebar and conversation loading feel slow. Boot was already fine — workspace
groups render collapsed and only a dozen rows mount — so the costs lived behind
two gestures: expanding a group and opening a long conversation. The extended
benchmark in `apps/web/tests/complex-history.perf.ts` (1,001 seeded sessions,
one 500-turn log, Chromium CDP metrics plus long-task and mutation probes)
priced each path before any fix:

- `session.list` over 1,001 cold sessions cost ~460ms warm and ~1.4–1.6s cold,
  all host-side: `JsonlSessionPersistence.listArtifacts` walked every session
  directory through one sequential syscall chain (two `exists()` probes — each
  an open plus, on absence, a parent stat — then the header read), and Node's
  four-thread libuv pool serializes that chain per log.
- Mounting 1,001 sidebar rows cost ~0.5s of main-thread work once per
  expansion; no virtualization.
- One list publish with every row mounted cost ~120ms of task time and ~14MB
  of short-lived heap with zero DOM mutations: `SessionRuntime.projectList`
  rebuilt every row object per pass, and the sidebar tree re-renders wholesale
  because its rows are not memoized.
- Opening a 500-turn conversation served the first 24-turn window in ~0.6s;
  paging the rest was bounded by layout over an ever-growing unvirtualized
  chat DOM (~12s wall for the full log).

## Decision

Two small fixes in the layers this branch owns; the larger costs are reported,
not fixed (see Consequences).

`projectList` restores per-row identity reuse (the archived design of
2d8f4dc991, dropped by a later refactor): a row whose fields all held keeps
its object reference, and `ids`, `byId`, `subagentsByParent`,
`jobsBySession`, and `currentAddress` keep their references when their
contents hold. The publish still happens on every pass — suppressing it was
the agent-preset staging regression that commit fixed — so gesture echoes
reach subscribers exactly as before while record-level selector consumers
(the lineage header reads `byId` whole) stop re-rendering on no-op passes.

`listArtifacts` fans its independent reads out under a new validated
`listConcurrency` config field (default 32) and answers both file probes from
one `readdir` per session directory, cutting the per-session syscall chain
from ~7 operations to 4 and running them pool-width instead of strictly
sequentially. Order, error precedence (earliest failure in discovery order),
and the duplicate-id rejection are unchanged; the existing 239-test suite
passes unmodified.

## Testing

`packages/client/runtime/tests/sessions-service.client.spec.ts` pins both
halves of the projection contract: an equivalent republish notifies
subscribers exactly once while every row and record keeps its reference, and
a row that did move is the only one replaced. Both cases fail without the
identity reuse and pass with it.

The persistence change is a pure performance change with no behavior delta;
the package suite pins the listing contract (legacy-layout rejection,
encoding mismatch, duplicate ids, torn files) unchanged. The browser
benchmark's before/after: `session.list` 464→261ms in-process, page boot
readiness 1510→852ms, and a no-op republish's heap churn 13.8→3.1MB.

## Consequences

The remaining measured costs live outside this branch's layer and are
deliberately reported, not fixed: sidebar rows re-render on every publish
because `SessionNodeItem` is unmemoized and the tree selects the whole list
state (packages/client/ui-workspace); chat history paging is layout-bound
over an unvirtualized conversation DOM (packages/client/ui-conversation);
host content search scans every session log per query (~5s at 1,001 stub
logs, packages/host/apiproxy — an index, not a fix here).

## Alternatives considered

**Skip the row rebuild entirely when the manager snapshot reference holds.**
The manager rebuilds that snapshot on every flush, so the shortcut never
fires; row-level reuse is the granularity that works.

**Raise the libuv thread-pool size for the host process.** A process-global
environment override for one code path is worse than needing fewer syscalls
on that path.

**Cache the listing between RPCs.** Invalidation against external edits to
the session root is unsound; the listing must reflect the filesystem.
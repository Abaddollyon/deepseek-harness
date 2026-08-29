# @deepseek-ai/dsh-jobs-local

English | [中文](README.zh.md)

Process-local implementation of the [`@deepseek-ai/dsh-jobs`](../jobs/README.md) registry contract: `LocalJobRegistry` keeps every record in memory, mints `<kind>-<uuid>` ids (or `<kind>-<idHint>` for a producer-supplied stable fragment), numbers each owner bucket with 1-based display ordinals, and hands out fresh snapshots, never live state. Load it as a plugin and it registers as `ctx.jobs`. With `persist: true` and a mounted [`ctx.jobStore`](../jobs-store-domain/README.md) it additionally mirrors records to the durable store; without a store its behavior is the pure in-memory registry.

## Admission

`maxConcurrentJobsPerOwner` is a positive safe integer and defaults to `10`. Before invoking a producer, `start()` counts the exact owner's `running` and `stopping` records through a session-keyed owner index; all unowned jobs share one separate service bucket. Terminal history does not occupy capacity, and only producer `done` settlement releases a stopping job's place.

At capacity, `start()` fails before producer execution and id allocation with an error that names the limit and tells the model to use `job_kill`, wait for the job to finish stopping, and retry. The registry does not queue, preempt, or maintain a second mutable counter.

## Lifecycle

Jobs belong to their owner and backend, not the producer tool fiber, so producer and controller reloads do not stop them. The first job for an owner attaches one awaited effect to the exact `Agent` scope. Owner disposal cancels that object's jobs, awaits producer quiescence, and removes their snapshots; reused agent or session ids cannot redirect an old cleanup.

Service disposal closes listeners, cancels all live jobs, awaits their records within `teardownGraceMs`, and detaches effects from surviving owner scopes. If teardown cancellation throws, the service force-fails the record and warns that work may be orphaned instead of deadlocking; a producer that never settles `done` is force-failed the same way once the grace expires (`producer did not release within teardownGraceMs; work may be orphaned`), so shutdown always completes.

Settlement is first-wins: the earliest terminal outcome — producer settlement, a rejected `done` contained as `failed`, or a teardown force-failure — records once, releases waiters, and notifies listeners once with per-listener containment. Pending waits mark the job reported before listeners run so completion reporters do not duplicate notices, and a teardown cancel marks it for the same reason: nothing will read a notice addressed to an owner being destroyed. Completion is the last thing a settlement announces, after the record is committed and the visible-set change is published, because a reporter may open a model turn synchronously and every other observer must already have seen the settled record.

Controllers and listeners are layered by the scope that registered them, in the tools-registry shape: a registration files into its registering context's scope, and a read unions the global layer with the owner's scope chain. One process-wide registry therefore answers per-owner questions per owner — `start()` refuses `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)` for an owner whose own composition attaches none, however many other compositions attach theirs, and a settlement reaches only the listeners its owner's composition registered.

## Durability

With `persist: true`, every commit point — registration, kill, settlement, the teardown stopping transition, and a terminal read/wait's `reported` flip — mirrors the record to `ctx.jobStore` fire-and-forget. A rejected write logs and degrades that one record to in-memory; the registry's own state stays authoritative. Final output is clipped to `maxPersistedOutputBytes` (tail retention) before persisting; the in-memory output is never clipped.

When a store mounts, the registry restores its records: terminal ones as-is (their persisted `reported` flag keeps notice gating correct across a restart), and non-terminal ones from a previous process incarnation either honest-settle immediately (`resumeSpec` null — `not resumable after host restart`) or wait, visible and killable, for their kind's `registerResumer` handler to adopt or decline them. A non-terminal record written by this incarnation is left untouched, because an in-process registry reload must not mistake live work for orphans. Restored records keep their session fence but have no live `Agent`, so their changes announce through the global observer lane.

Settled history is bounded per owner by `maxSettledJobs`: reported terminal records beyond the cap are evicted FIFO (memory and durable mirror together), while an unreported terminal record always survives — evicting it would lose the completion notice the model never read.

## Config

| key | default | meaning |
|---|---|---|
| `maxConcurrentJobsPerOwner` | `10` | active (`running` + `stopping`) jobs per exact owner or the shared unowned bucket |
| `persist` | `false` | mirror records to a mounted `ctx.jobStore`; with no store mounted, records stay in-memory |
| `maxSettledJobs` | `100` | per-owner FIFO cap on retained reported terminal records; `0` retains none |
| `teardownGraceMs` | `10000` | bound on `disposeAll`'s wait for producers to release before force-failing their records |
| `maxPersistedOutputBytes` | `65536` | byte cap on a record's persisted final output (tail retention) |

## Model Experience

Indirectly, through producer plugins and [`dsh-tool-jobs`](../tool-jobs/README.md), which render job ids, output, status, cancellation, and completion notices.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Execution is process-local even with persistence** — the record survives a restart; the running producer does not. Cross-restart continuation exists only for kinds whose plugins register a resumer, and everything else honest-settles.
- **`persist: true` without a mounted store is silent** — the registry cannot distinguish "store loads later" from "store never configured", so records stay in-memory until one appears; the composition owns providing `ctx.jobStore`.
- **A silently ineffective cancel holds capacity until teardown** — if `cancel` returns without settling `done`, the registry cannot distinguish it from a slow stop; the job keeps one bucket slot until service teardown force-fails it at the grace boundary.

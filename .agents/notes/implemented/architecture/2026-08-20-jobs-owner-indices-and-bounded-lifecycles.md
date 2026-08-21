# Agent Note: Owner-indexed background jobs with bounded retention and teardown

Status: implemented

English | [中文](2026-08-20-jobs-owner-indices-and-bounded-lifecycles.zh.md)

## Problem

The local jobs registry kept one flat `store` of every job it had ever admitted and answered every question by scanning it. `list(caller)` walked the whole store to filter by owner, and admission counted live work the same way, so a host running many sessions paid O(sessions × jobs) on paths the GUI hits constantly — the mux baseline pushes a `session/jobs` frame per session on every stream open, and the unowned-job fan-out repeats that for every subscriber.

Nothing bounded the store. Terminal records were retained forever together with their buffered output, so a long-lived host accumulated settled jobs and their payloads until the process exited.

Teardown had no bound either. `disposeOwned` and `disposeAll` cancelled the owned records and then `await Promise.all(job.settled)` with no deadline; only a *throwing* `cancel()` was force-failed. The producer contract already admitted the hole — a cancel that returns without settling `done` is indistinguishable from a slow stop — so one uncooperative producer wedged agent disposal and, above it, host shutdown. That is D9 of the interruption investigation.

Finally, a job completion notice woke an idle owner unconditionally within its wake budget. After a human pressed stop, the owner is idle, so a job settling afterwards opened a fresh turn on the session the user had just ended — the same shape as the subagent settlement notice defect recorded in the [cancellation-convergence note](../bug-fix/2026-08-20-cancellation-convergence-across-the-agent-tree.md).

## Decision

**Index by owner instead of scanning.** `ownedJobs: Map<string, Set<TrackedTask>>` buckets records by owner *session id* — not by the exact `Agent` object — so a same-id caller sees the current owner's jobs, while exact-owner questions (admission counts, owner-disposal draining) filter the bucket by identity. `unownedJobs` is the shared bucket. `list` merges the caller's bucket with the unowned one in registration order rather than filtering the world.

**Count admission, do not recount it.** `activeCounts: Map<Agent | undefined, number>` holds live (`running`/`stopping`) counts per exact owner, with the `undefined` key for the unowned bucket. It is incremented at registration and decremented by the first effective settlement, so admission never touches the store.

**Bound terminal retention.** `settledJobs` is a settlement-ordered set holding terminal records only, and `maxSettledJobs` (validated `Config`, default 256) evicts from the front. Eviction drops the record from every index, releases its buffered output, and notifies each affected owner's observers, because eviction changes what `list` returns. Live jobs are never evictable — the set holds terminal records only, so the bound cannot reach running work.

**Bound teardown.** `teardownGraceMs` (validated `Config`, default 5000) caps the settlement join. After the grace, the record is force-settled `failed` and teardown proceeds without awaiting that producer again, which is exactly the semantics the throwing-cancel branch already had.

**Make the completion wake stop-aware.** The `tool-jobs` notice consults the owner's newest durable `turn/end` before spending a wake, and delivers through the non-waking `inject` when that ending is an abort the user caused. The notice still lands in the inbox; it just does not re-open the turn.

## Alternatives considered

**Key the owner buckets by the exact `Agent` object.** Rejected: a session whose Agent is replaced (cold resume, preset switch) would strand its jobs in an unreachable bucket. The session id is the durable identity a caller actually holds; identity filtering is applied only where exactness is the question, and the code says so at the field.

**Bound retention by age or by total buffered bytes.** Rejected for this change: a count is the bound whose behavior a reader can predict from the tool description, and the output payload is already bounded per read. A byte ceiling remains available if a deployment reports pressure.

**Force-fail a non-settling producer immediately instead of after a grace.** Rejected: a slow but correct stop — a subprocess in its SIGTERM-to-SIGKILL window — is the common case, and reporting it as a failure would be a lie for the sake of a millisecond.

**Let the wake budget alone handle the post-stop wake.** Rejected: the budget bounds *how many* wakes a burst may spend, not whether waking is correct at all. After a human stop, zero is the right number, and the durable `turn/end` is the fact that says so.

## Consequences

Admission and listing are O(1) and O(owned + unowned) respectively; neither scales with the corpus. An evicted settled id reads as an unknown job — a behavior change a caller can observe, documented on the config field, and the reason eviction notifies observers rather than mutating silently. Teardown now completes in bounded time and reports a stuck producer as `failed` rather than hanging, so an agent disposal can no longer be pinned by one job. A job settling after a human stop no longer restarts that session.

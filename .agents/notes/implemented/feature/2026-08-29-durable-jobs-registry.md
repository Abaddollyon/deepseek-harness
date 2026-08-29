# Agent Note: Durable background-job registry

Status: implemented

English | [中文](2026-08-29-durable-jobs-registry.zh.md)

## Problem

Background-job records lived only in a process-local map, and ids were minted from a per-process counter (`<kind>-N`). A host restart therefore destroyed every record — including completions the model had never read — and a persisted id could not be trusted: a fresh process would re-mint `subagent-1` for different work. Durable run supervision (resume where possible, settle honestly otherwise) needs an id that is stable across restarts, a durable record, and a seam through which a later process can adopt or close what it finds.

## Decision

Three coordinated changes across the `packages/jobs` group.

**Ids become `<kind>-<uuid>`** (or `<kind>-<idHint>` for a producer-supplied stable fragment), so a durable record's key is never re-minted for different work. The model-facing cost of 36-character ids is paid by a per-owner 1-based display `ordinal` carried in every snapshot and rendered first by `job_list`; the full id stays present because it is what the other job tools accept. This is a deliberate pre-release breaking change with every reference updated and no compat shim.

**A durable store seam, `ctx.jobStore`** (`dsh-jobs-store-domain`), over the storage domain form: one `records` table keyed by `JobId`, zod-validated at the durable boundary, domain version 1 reject-only — a version-mismatched medium fails loud at open rather than silently discarding records that may describe running work. Records persist exactly the facts that must survive a restart: owner session (the access fence), status/detail/bounded output, `reported` (notice gating — a restored completion the model already collected must not re-announce), `resumeSpec` (boot adoption), and the owning `incarnation`. The incarnation is a process fact minted once at module load (`PROCESS_INCARNATION`), so an in-process plugin reload never mistakes live work for restart orphans. Writes coalesce per id inside `writeBatchMaxDelayMs` (job records are monotone lifecycle snapshots; last-write-wins per id is sound).

**The registry mirrors and restores.** `dsh-jobs-local` gains opt-in `persist`: registration, kill, settlement, teardown transitions, and terminal `reported` flips write fire-and-forget onto the store's chain; a rejected write logs and degrades that one record to in-memory (the recorder-degrade containment shape). On adopting a store it restores records — terminal ones as-is, prior-incarnation non-terminal ones honest-settled (`not resumable after host restart`) unless a `registerResumer` handler for their kind adopts them under the original id. Retention (`maxSettledJobs`) evicts only reported terminal records FIFO per owner — an unreported terminal record is a notice the model never read and always survives — and `teardownGraceMs` bounds `disposeAll` so a producer that never releases is force-failed (`producer did not release within teardownGraceMs; work may be orphaned`) instead of wedging shutdown. A session-keyed `byOwner` index replaces the linear owner scans that retained history would have made O(records).

## Alternatives considered

**Keep counter ids and persist the counter.** Rejected: the counter is shared global state a crash can lose, and any two processes over one medium would race it; uuids need no coordination and make adoption under the original id sound.

**Make the store mandatory for the registry.** Rejected: TUI and one-shot profiles need no persistence; `persist: false` (default) keeps behavior byte-identical to the pure in-memory registry, proven by the pre-existing suite passing unchanged apart from id-shape assertions.

**Honest-settle everything at boot (no resumer seam).** Rejected: continuable subagents are genuinely resumable today and more kinds may follow; `registerResumer` puts the adopt-or-decline decision with the kind's producer while defaulting to the honest failure.

**Evict oldest terminal records regardless of `reported`.** Rejected: evicting an unreported completion silently loses the one notice gating exists to deliver.

## Consequences

Restart durability is now a composition choice: mount `jobs-store-domain` (routed to a real medium by `storage-domain`) and set `persist: true`. The later run-supervisor slice builds boot reconciliation and owner notices on `registerResumer`, the persisted `reported` flag, and `incarnation` without further registry surgery. Model-visible changes are the `job_list` row shape (`#<ordinal> [<kind>] … (id: <id>)`) and uuid ids in acks and notices; cross-package test suites that asserted `bash-1`-style ids now read ids from the producing call. Execution remains process-local: the record survives, the running producer does not, and only resumer-equipped kinds continue across restarts.

---
description: "The durable job-store seam and storage-domain provider for maintainers composing, operating, or debugging restart-safe background jobs."
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs-store-domain

English | [中文](README.zh.md)

## Summary

The durable job-store seam (`ctx.jobStore`) and its provider over the storage domain data form. The abstract `JobStore` defines synchronous reads with read-your-writes, whole-record `put`, and `delete`; `DomainJobStore` (the default export) implements it over `ctx.storageDomain` with one `records` table keyed by `JobId`. [`dsh-jobs-local`](../jobs-local/README.md) writes records here fire-and-forget when its `persist` flag is on, and reads them back at boot to restore, resume, or honestly settle work that outlived its host process.

## Table of Contents

- [Durable shape](#durable-shape)
- [Write coalescing](#write-coalescing)
- [Config](#config)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="durable-shape"></a>
## Durable shape

`JOBS_DOMAIN_VERSION = 1` is stamped into the backend unit and is reject-only: a medium stamped with a different version fails loud at open, never silently discarding records — a discarded record would be a lie about work that may still be running. Every stored record is zod-validated (`jobRecordSchema`) at the durable boundary; a failing record surfaces `invalid-record` with its table and key. Records carry the registry snapshot facts that must survive a restart — id, kind, label, `ownerSession`, status, detail, bounded output, timestamps, `reported` (notice gating), `outputLimitBytes`, `resumeSpec` (boot adoption), the owning `incarnation` — plus a record-level `schemaVersion: 1` inside the domain version. The domain global records the last boot: `{ incarnation, bootedAt }`, stamped at open with `PROCESS_INCARNATION`, the process fact minted once at module load.

<a id="write-coalescing"></a>
## Write coalescing

`put` coalesces rapid successive writes of one id inside `writeBatchMaxDelayMs`: the latest value supersedes the queued one and every caller shares the single durable write's settlement. Job records are monotone lifecycle snapshots, so last-write-wins per id is correct. Reads (`get`/`list`) see queued values before they land. `delete` discards any queued write for the id (resolving its writers — their record was deliberately removed, not lost) and reports whether a stored or queued record existed. Closing flushes every queued write before releasing the domain; a flush failure rejects only its writer's promise.

<a id="config"></a>
## Config

| key | default | meaning |
|---|---|---|
| `domainName` | `jobs` | domain (and backend unit) name the store opens |
| `writeBatchMaxDelayMs` | `200` | per-id write coalescing window in milliseconds |

Which backend medium serves the domain is the `storage-domain` plugin's routing decision (`backend`/`routes`), not this package's.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the registry that mirrors records here and [`dsh-tool-jobs`](../tool-jobs/README.md), which renders what the registry restores — including the persisted `reported` flag that keeps a restored, already-collected completion from producing a duplicate notice.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The store is a mirror, not an authority** — the in-memory registry stays authoritative while the process lives; a rejected write degrades that record to in-memory rather than failing the job.
- **Coalescing trades a bounded durability window for write volume** — a hard crash inside `writeBatchMaxDelayMs` can lose the latest transition (never a whole record that had landed before).
- **No cross-process locking** — one process owns a domain at a time; concurrent hosts over one medium are out of scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

No runtime invariant companion is published because this plugin exposes durable storage and reconciliation behavior through its public service seam; package tests cover the lifecycle directly.

</details>

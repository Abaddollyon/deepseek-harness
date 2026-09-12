---
description: "The durable job boot-reconciliation consumer for maintainers configuring resume policy, durable accounts, model notices, and orphan retention."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-supervisor

English | [中文](README.zh.md)

## Summary

Use `dsh-run-supervisor` to reconcile persisted jobs after a host restart. It resolves each job's owning session, applies bounded adoption policy, and durably records resumed or abandoned work. Completion notices and job-tool results expose outcomes to the model; the accounting events remain log-only.

Choose it when a composition persists background jobs. Mount it after `jobs-local` and `jobs-store-domain`; producer plugins must supply handlers for resumable work.

## Table of Contents

- [Boot reconciliation](#boot-reconciliation)
- [Durable accounts and model notices](#model-visible-account)
- [Orphan retention](#orphan-retention)
- [Config](#config)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="boot-reconciliation"></a>
## Boot reconciliation

[`dsh-jobs-local`](../jobs-local/README.md) restores records from [`ctx.jobStore`](../jobs-store-domain/README.md): terminal records remain terminal, prior-incarnation non-resumable work settles, and resumable work waits for a producer's `registerResumer` handler. Reconciliation runs once per store activation, after the registry's earlier-registered adoption fiber, bounded by `bootResumeTimeoutMs`. A record the registry never restored (`persist: false`, or incorrectly ordered composition rows) is logged once and left alone. The pass proceeds as follows:

1. Enumerate the store's running records, plus restored workflow records terminalized from `stopping` as killed, whose `incarnation` differs from `PROCESS_INCARNATION`. Same-incarnation records are live in-process work — an HMR reload must never mistake them for orphans — and restored stopping records are accounted as abandoned without restart or notice.
2. Group by `ownerSession` and resolve each owner: a live agent (`ctx.agents.get`), else a stored session that opens and reads through a non-owning `sessionPersistence.open(id, 'read')` handle, else an orphan. The read handle closes before resolution returns. With no persistence seam the owner is *unknown*, not orphaned: nothing is settled or evicted on the absence of evidence.
3. Policy decides each pending record's fate. `resumeOnBoot: false` settles everything. An orphan owner's records settle as `'owner-unavailable'`. The first `maxResumedRunsPerOwner` records per owner (oldest first) stay *adoptable* and wait for their kind's producer resumer; the overflow settles with the cap detail so a restart cannot stampede past the registry's per-owner concurrency limit.
4. Adoption itself belongs to producers: a `registerResumer` handler returning hooks re-adopts the record under its original id, which the registry announces through `onJobAdopted` after the re-stamped record commits — awaiting the account before the producer's completion wiring attaches — and the supervisor accounts as `run/resumed`. The marker put is required: a store that rejects it fails the resume honestly instead of running an unmarked adoption. An adoption no pass observed — a resumer that fired before the supervisor mounted, or a process that died before accounting — leaves the durable `adoptedFromIncarnation` marker on the record. The next pass accounts it as `run/resumed`, naming that prior incarnation. A workflow stranded while stopping then receives its workflow closers and `run/abandoned` under the incarnation that ran the adopted work, so later boots find the same abandonment account; another terminal killed workflow receives `run/abandoned` and workflow closers without a false resume claim. A marker clears only after the account and any required workflow closure are confirmed recorded or found already present; an owner no lane can reach, or a failed append, keeps it for a later boot. A resumer that declines or throws is accounted as `run/abandoned` with `reason: 'resume-failed'`.
5. Whatever is still pending when the deadline passes settles as `'reconcile-timeout'` — the pass always completes and the process always boots.

Supervisor-driven settlement goes through the registry's `registerResumer` decline lane: first-wins terminal records, `reported` preserved, completion listeners notified. That lane replays a whole kind at once, so settle-targets of a kind that still has adoptable records pending wait until those resolve or the deadline passes.

<a id="model-visible-account"></a>
## Durable accounts and model notices

Three log-only session events are declared here (declaration-merged into `SessionEventMap`, none `ignorable` — a reader that does not know a run's fate must refuse the log):

- `run/resumed` — a run outlived its host process and was re-adopted, with the `priorIncarnation` that wrote the record.
- `run/abandoned` — a run was settled honestly, with `reason` (`'not-resumable' | 'owner-unavailable' | 'reconcile-timeout' | 'resume-failed'`) and a human-readable `detail`.
- `run/detached` — declared here so the `run/*` vocabulary has one home, but EMITTED by the later workflow slice (`dsh-tool-workflow` under `ownership: 'supervisor'`), never by this plugin.

Events reach the owner session through whichever lane can: the live session append, followed by `ctx.sessions.flush(session)` before the account is acknowledged, when the agent is registered; otherwise an exclusive `sessionPersistence.open(id, 'write')` handle that reads the next seq, appends, flushes, and closes before acknowledging the account. A failed offline operation retries through the live lane if the session has come live. A failed flush retains the adoption marker for a later boot. The account is asymmetric for one job incarnation: an existing `run/abandoned` satisfies a later `run/resumed` retry, but `run/resumed` never suppresses a later `run/abandoned` settlement. An exact event already present is not appended again, so re-boots never duplicate either account.

An unreported terminal record additionally owes its owner exactly one completion notice — none when the persisted `reported` flag says the model already collected it. The notice is delivered to a live owner only (injected, shaped like `dsh-tool-jobs`' completion notices but sourced `plugin: 'run-supervisor'`), after which the supervisor claims the record reported through the registry so no later boot re-delivers. For an owner that is restorable but not live, the durable `run/abandoned` event is recorded for the session log; it is log-only and does not itself become model message history. The restored owner can inspect the job through the job tools when it next resumes.

The fenced public registry surface admits no custom terminal detail, so a record the supervisor settles carries the registry's own honest detail (`'not resumable after host restart'`) while the precise reason lives in the `run/abandoned` event and the notice text. The session event is the durable account; only completion notices and job-tool results are model-visible.

<a id="orphan-retention"></a>
## Orphan retention

Terminal records whose owner session can neither be found live nor listed by persistence are evicted from the durable store once `orphanRetentionMs` has passed since they settled (`0` evicts at the first classifying boot). The in-memory restored copy lingers, fenced to its dead session and therefore invisible to every caller, until process exit; the durable eviction is what bounds how long the orphan stays listable across boots.

<a id="config"></a>
## Config

| key | default | meaning |
|---|---|---|
| `resumeOnBoot` | `true` | resume restorable runs at boot; `false` honest-settles every pending prior-incarnation record |
| `bootResumeTimeoutMs` | `30000` | bounds the whole reconciliation pass; the remainder settles as `'reconcile-timeout'` |
| `maxResumedRunsPerOwner` | `10` | per-owner adoption budget at boot; the overflow honest-settles |
| `orphanRetentionMs` | `604800000` (7 d) | how long an honest-settled orphan record stays in the durable store |

<a id="model-experience"></a>
## Model Experience

Indirectly, through live-owner completion notices and [`dsh-tool-jobs`](../tool-jobs/README.md) results that bring boot outcomes into model context, while `run/*` events remain log-only and consume no model tokens.

#### KV Cache effect

The log-only events do not change model messages or their cached prefix. Accepted notices and job-tool results append to model history without replacing earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The per-owner budget binds only what the supervisor settles** — a producer resumer registered before the settlement sweep replays and may adopt EVERY pending record of its kind (registry replay is kind-granular); `maxResumedRunsPerOwner` governs which records remain pending to be adopted, not the producer's own replay.
- **Settle-targets share their kind's timing** — the decline lane settles a whole kind at once, so a target whose kind still has adoptable records waits for their resolution or the deadline rather than settling immediately.
- **Resumed records are not lifecycle-attached to the restored agent** — the registry binds owner cleanup at `start()`, and a resumed record keeps no live owner: disposing the owner agent does not cancel resumed work (the job tools and registry teardown still reach it).
- **No first-turn gating or resume notice replay** — reconciliation does not block an owner's first model turn or subscribe to later owner attachment. An offline account remains in the log; resuming alone neither projects it into model history nor injects a completion notice.
- **Live accounting requires a durability listener** — a missing Session store or a flush with no listener leaves the account unacknowledged. A rejected flush retains the adoption marker; the registry does not start a producer whose account the supervisor rejects.
- **Notices inject, never wake** — `tool-jobs` owns the wake budget, so an idle restored owner is not woken at boot; its notices wait in the inbox for the next turn.
- **Composition order is a contract** — mounted before `jobs-local`'s store adoption, the pass finds records the registry has not restored, warns once, and skips them until the next store activation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

No runtime invariant companion is published because this plugin exposes durable storage and reconciliation behavior through its public service seam; package tests cover the lifecycle directly.

</details>

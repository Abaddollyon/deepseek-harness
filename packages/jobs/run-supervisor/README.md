---
description: "The durable job boot-reconciliation consumer for maintainers configuring resume policy, model-visible accounts, and orphan retention."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-supervisor

English | [中文](README.zh.md)

## Summary

The boot-reconciliation consumer of the durable job registry. When the host restarts, [`dsh-jobs-local`](../jobs-local/README.md) restores persisted records over [`ctx.jobStore`](../jobs-store-domain/README.md) — terminal ones as-is, prior-incarnation non-resumable ones honestly settled, prior-incarnation resumable ones left pending for a producer `registerResumer` handler — and deliberately stops there: it keeps no session awareness and no policy. This plugin owns what remains: resolving each restored record's owning session, deciding which pending records may still be adopted, settling the rest honestly, and recording every outcome where the model can find it.

Mount it in the host composition AFTER `jobs-local` and `jobs-store-domain`: reconciliation triggers when the store service activates, and the registry's own store adoption (an earlier-registered inject fiber) must have run first. A record the registry never restored (`persist: false`, or a composition that ordered the rows wrong) is logged once and left alone.

## Table of Contents

- [Boot reconciliation](#boot-reconciliation)
- [The model-visible account](#model-visible-account)
- [Orphan retention](#orphan-retention)
- [Config](#config)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="boot-reconciliation"></a>
## Boot reconciliation

One pass per store activation, bounded by `bootResumeTimeoutMs`:

1. Enumerate the store's running records, plus restored workflow records terminalized from `stopping` as killed, whose `incarnation` differs from `PROCESS_INCARNATION`. Same-incarnation records are live in-process work — an HMR reload must never mistake them for orphans — and restored stopping records are accounted as abandoned without restart or notice.
2. Group by `ownerSession` and resolve each owner: a live agent (`ctx.agents.get`), else a session the real resume path can restore (`ctx.sessionPersistence.prepare`, disposed immediately — restorability is the fact, not the session object), else an orphan. With no persistence seam the owner is *unknown*, not orphaned: nothing is settled or evicted on the absence of evidence.
3. Policy decides each pending record's fate. `resumeOnBoot: false` settles everything. An orphan owner's records settle as `'owner-unavailable'`. The first `maxResumedRunsPerOwner` records per owner (oldest first) stay *adoptable* and wait for their kind's producer resumer; the overflow settles with the cap detail so a restart cannot stampede past the registry's per-owner concurrency limit.
4. Adoption itself belongs to producers: a `registerResumer` handler returning hooks re-adopts the record under its original id, which the registry announces through `onJobAdopted` after the re-stamped record commits — awaiting the account before the producer's completion wiring attaches — and the supervisor accounts as `run/resumed`. The marker put is required: a store that rejects it fails the resume honestly instead of running an unmarked adoption. An adoption no pass observed — a resumer that fired before the supervisor mounted, or a process that died before accounting — leaves the durable `adoptedFromIncarnation` marker on the record. The next pass accounts it as `run/resumed`, naming that prior incarnation. A workflow stranded while stopping then receives its workflow closers and `run/abandoned` under the incarnation that ran the adopted work, so later boots find the same abandonment account; another terminal killed workflow receives `run/abandoned` and workflow closers without a false resume claim. A marker clears only after the account and any required workflow closure are confirmed recorded or found already present; an owner no lane can reach, or a failed append, keeps it for a later boot. A resumer that declines or throws is accounted as `run/abandoned` with `reason: 'resume-failed'`.
5. Whatever is still pending when the deadline passes settles as `'reconcile-timeout'` — the pass always completes and the process always boots.

Supervisor-driven settlement goes through the registry's `registerResumer` decline lane: first-wins terminal records, `reported` preserved, completion listeners notified. That lane replays a whole kind at once, so settle-targets of a kind that still has adoptable records pending wait until those resolve or the deadline passes.

<a id="model-visible-account"></a>
## The model-visible account

Three log-only session events are declared here (declaration-merged into `SessionEventMap`, none `ignorable` — a reader that does not know a run's fate must refuse the log):

- `run/resumed` — a run outlived its host process and was re-adopted, with the `priorIncarnation` that wrote the record.
- `run/abandoned` — a run was settled honestly, with `reason` (`'not-resumable' | 'owner-unavailable' | 'reconcile-timeout' | 'resume-failed'`) and a human-readable `detail`.
- `run/detached` — declared here so the `run/*` vocabulary has one home, but EMITTED by the later workflow slice (`dsh-tool-workflow` under `ownership: 'supervisor'`), never by this plugin.

Events reach the owner session through whichever lane can: the live session append when the agent is registered, else a durable offline append through `sessionPersistence` at the log's next seq (retried through the live lane if the session comes live mid-append). The account is asymmetric for one job incarnation: an existing `run/abandoned` satisfies a later `run/resumed` retry, but `run/resumed` never suppresses a later `run/abandoned` settlement. An exact event already present is not appended again, so re-boots never duplicate either account.

An unreported terminal record additionally owes its owner exactly one completion notice — none when the persisted `reported` flag says the model already collected it. The notice is delivered to a live owner only (injected, shaped like `dsh-tool-jobs`' completion notices but sourced `plugin: 'run-supervisor'`), after which the supervisor claims the record reported through the registry so no later boot re-delivers. For an owner that is restorable but not live, the durable `run/abandoned` event IS the account: the model meets it in its own history whenever the session next resumes.

The fenced public registry surface admits no custom terminal detail, so a record the supervisor settles carries the registry's own honest detail (`'not resumable after host restart'`) while the precise reason lives in the `run/abandoned` event and the notice text. This is deliberate: the session event is the model-visible account; the record detail stays truthful about which lane settled it.

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

Indirectly, through the `run/*` session events and completion notices appended to the owner session, which the session log and [`dsh-tool-jobs`](../tool-jobs/README.md)-shaped notices render into the transcript like any other completion.

#### KV Cache effect

No direct invalidation; the appended events and one notice per unreported settlement join the owner session's tail like any completion the model reads next turn.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The per-owner budget binds only what the supervisor settles** — a producer resumer registered before the settlement sweep replays and may adopt EVERY pending record of its kind (registry replay is kind-granular); `maxResumedRunsPerOwner` governs which records remain pending to be adopted, not the producer's own replay.
- **Settle-targets share their kind's timing** — the decline lane settles a whole kind at once, so a target whose kind still has adoptable records waits for their resolution or the deadline rather than settling immediately.
- **Resumed records are not lifecycle-attached to the restored agent** — the registry binds owner cleanup at `start()`, and a resumed record keeps no live owner: disposing the owner agent does not cancel resumed work (the job tools and registry teardown still reach it).
- **No first-turn gating** — no host-plane seam lets the supervisor block an owner session's first model turn; reconciliation runs at host boot before agent compositions restore sessions in the standard boot order, and durable offline appends make the account visible whenever the session next loads.
- **Notices inject, never wake** — `tool-jobs` owns the wake budget, so an idle restored owner is not woken at boot; its notices wait in the inbox for the next turn.
- **Composition order is a contract** — mounted before `jobs-local`'s store adoption, the pass finds records the registry has not restored, warns once, and skips them until the next store activation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

No runtime invariant companion is published because this plugin exposes durable storage and reconciliation behavior through its public service seam; package tests cover the lifecycle directly.

</details>

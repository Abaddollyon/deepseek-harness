# Agent Note: Run supervisor — boot reconciliation for durable job records

Status: implemented

English | [中文](2026-08-29-run-supervisor-boot-reconciliation.zh.md)

## Problem

The durable job registry (slice J) restores persisted records at boot and then stops: it keeps no session awareness and no policy. Left to itself, a prior-incarnation resumable record whose producer never registers a resumer would sit `running` forever — a lie about work that died with the last process — and a record the boot restore honest-settled would reach the model through no channel at all: restored settlements carry no live owner, so `tool-jobs`' completion listener skips them, and no session event named what happened. Somebody host-plane had to own owner resolution, the resume policy knobs, the model-visible account, and orphan retention.

## Decision

A new Consumer package, `@deepseek-ai/dsh-run-supervisor`, mounted host-plane after `jobs-local` and `jobs-store-domain`. It injects `['jobs']` and treats `jobStore`, `agents`, and `sessionPersistence` as optional. When the store service activates (its inject fiber fires after the registry's earlier-registered adoption fiber), one bounded pass runs:

1. Enumerate running records whose `incarnation` differs from `PROCESS_INCARNATION` — the same-incarnation check is what keeps an in-process reload from honest-settling live work; previous-incarnation durable `stopping` records are terminalized as killed with the canonical restart-cancellation detail and never re-enter resume; same-incarnation `stopping` remains live work during in-process reload. Registry membership is probed through `get()`'s fence errors: `'unknown job'` means the registry never restored the record (persist disabled), so it is logged once and left alone.
2. Group by `ownerSession` and resolve each owner: live agent, restorable session (`sessionPersistence.prepare`, disposed immediately), orphan, or — with no persistence seam — *unknown*, which settles nothing on the absence of evidence.
3. Apply policy: `resumeOnBoot: false` settles everything; orphan-owned records settle `'owner-unavailable'`; the oldest `maxResumedRunsPerOwner` per owner stay adoptable while the overflow settles with the cap detail; whatever outlives `bootResumeTimeoutMs` settles `'reconcile-timeout'`. The pass always completes and the process always boots.
4. Drive settlement through the registry's `registerResumer` decline lane — the only unfenced public lane that reaches a restored record. It preserves `reported`, keeps first-wins terminal semantics, and routes the settlement back through the supervisor's own `onJobDone` listener for accounting. Because the lane replays a whole kind at once, settle-targets of a kind with adoptable records still pending wait for the kind's resolution or the deadline.
5. Account everything: a producer resumer returns a deferred start plan; the registry commits the re-stamped record, awaits every `onJobAdopted` observer, and starts the producer only when no observer explicitly vetoes ownership. An adoption no pass observed — a resumer that fired before the supervisor mounted, or a process that died before accounting — is proven by the durable `adoptedFromIncarnation` marker, which the next pass accounts from the observed durable state: a running marker becomes `run/resumed` naming the marked incarnation, while a terminal killed workflow marker becomes `run/abandoned` after its member/run closers; either marker clears only once those required appends are confirmed recorded or found already present — an owner no lane can reach keeps the marker for a later boot. The supervisor retains the recovered candidate until its completion is observed, including a terminal marker restored before supervisor mount. `run/resumed` and `run/abandoned` (declaration-merged, log-only, never `ignorable`) are appended to the owner session through the live append or a durable offline append at the log's next seq; an exact event already present is not appended again; an existing `run/abandoned` also satisfies a later `run/resumed` retry, but `run/resumed` never suppresses the later `run/abandoned` settlement, so re-boots neither duplicate nor lose the terminal account. An unreported terminal record owes its live owner exactly one injected completion notice (zero when `reported` was persisted true), after which the supervisor claims the record reported through `jobs.wait` — never `read`, which would consume a stream job's output cursor. `run/detached` is declared here for one `run/*` vocabulary home but is emitted by the later workflow slice.
6. Evict unowned terminal records directly, and owned terminal records whose owner is neither live nor listed by persistence, once `orphanRetentionMs` passes — durable-store eviction only; an owned in-memory copy lingers fenced to its dead session, invisible to every caller.

Every limit is a validated Config field (`resumeOnBoot`, `bootResumeTimeoutMs` capped at `MAX_TIMER_DELAY_MS`, `maxResumedRunsPerOwner`, `orphanRetentionMs`); misconfiguration fails loud at load.

## Alternatives considered

**Let the registry emit the session events.** Rejected: the registry is deliberately session-unaware and process-local; the Consumer owns the model-visible account, matching the seam doc's Definition/Provider/Consumer split.

**Write the design's exact detail strings onto settled records.** Not reachable: the fenced public surface admits no custom terminal detail — `kill` marks reported and settles `killed`, and the decline lane hardcodes the registry's honest detail. Records therefore carry `'not resumable after host restart'` while the precise reason lives in the `run/abandoned` event and notice text, which the design designates as the model-visible account. Documented in the README rather than shimmed.

**Invoke producer resumers through the supervisor to enforce the cap.** Rejected: producers own resume logic and register it directly with the registry, whose replay is kind-granular. The cap therefore binds only records still pending when the supervisor classifies them; a producer resumer registered earlier replays (and may adopt) every pending record of its kind. Recorded as a known limitation.

**Wake idle restored owners with their boot notices.** Rejected: the wake budget is `tool-jobs`-private and unshareable without new tunables; notices inject and wait for the next turn, and no aggregation is added — the parent's "no notice aggregation" decision stands.

## Consequences

A host restart is now fully accounted: genuinely resumable kinds continue through their producers' resumers under the original ids, everything else settles honestly with a session-log reason the model can reconstruct, unreported completions notice exactly once, and orphaned records age out of the durable store. Resumed records are not lifecycle-attached to the restored agent (owner cleanup binds at `start()`), so owner disposal does not cancel them — the job tools and registry teardown still reach them. The workflow slice builds `run/detached` and the supervisor-owned workflow handoff on these events without further changes here.

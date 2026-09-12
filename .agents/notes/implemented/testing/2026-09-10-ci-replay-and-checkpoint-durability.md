# Agent Note: CI replay inputs and checkpoint completion

Status: implemented

English | [中文](2026-09-10-ci-replay-and-checkpoint-durability.zh.md)

## Problem

A released Session generation serves as durable reader evidence, but its original writer output need not match intentional behavior added within the same format version. Replacing that generation destroys the reader fixture; removing workflow phases or child labels from comparisons hides persisted behavior. Independently, a cache test that reads an atomic-replacement target while an automatic write is pending cannot distinguish incomplete work from a rejected write or stale checkpoint.

## Decision

### Immutable replay inputs and strict writer expectations

The [snapshot manifest](../../../../packages/test-support/session-snapshot/src/manifest.ts) accepts `writerOracle: separate` for owned current-format headless and ACP replay inputs. It is distinct from historical `sessionFormat` retention and cannot accompany that declaration or an external `session` reference. Existing generation files remain replay inputs; `writer.expected.jsonl` and its ordinal child counterparts contain the complete native writer output. The adapters and [corpus check](../../../../scripts/session-snapshot-corpus.corpus.ts) share the [inventory assertion](../../../../packages/test-support/session-snapshot/src/session-files.ts), which requires exact parent/child oracle inventory and current-format headers. Historical retention still requires a format preceding the current writer.

Separate oracles preserve intentional workflow phase events, child labels, and the resulting event references. A missing current-generation fixture instead receives a genuine native-writer successor; converting a legacy file's schema alone does not establish current writer behavior. Prompt and schema sidecars follow the owning advertised output rather than removing supported options to match stale text.

Recorded job scenarios use [instance-local deterministic identity hints](../../../../apps/cli/tests/profiles/sdk/fixtures/deterministic-jobs.ts) in both record and replay compositions. Admission limits, storage, and execution remain in the real registry. The [retry adapter](../../../../apps/cli/tests/profiles/headless/tests/fixtures/retry-snapshot-backend.mjs) distinguishes title requests from main requests so title generation cannot consume the main request's transient-failure sequence.

### Checkpoint ordering and observable completion

The [projection cache](../../../../packages/session/session-projection-cache/src/index.ts) reserves per-Session write order when it captures checkpoint rows, before awaiting log-flush completion. A delayed creation flush therefore cannot admit an older checkpoint after a newer event or disposal checkpoint. A rejected flush retains its queue position until earlier writes settle, rejects without publishing unflushed rows, and permits subsequent recovery. Log flushing still starts while the Session is live; it is not deferred until after detach.

Automatic-write tests observe the real `cache.write` calls, assert the triggering lifecycle or event count, await their returned promises, and then read physical JSON. A real `session/flush` listener barrier pins out-of-order readiness. These tests neither replace storage nor poll the replacement target during the write.

### Image pressure and post-prune admission

[Automatic compaction](../../../../packages/compaction/compaction-basic/src/index.ts) rechecks both the configured soft threshold and hard request capacity after tool-result pruning. A mounted pruner that removes nothing cannot suppress summary compaction merely because the request remains below hard capacity. The [image scenario](../../../../snapshots/acp/image-compaction/cordis.snapshot.yml) retains the pruner and budgets summary output independently from main output. Its summary allowance leaves room for the image-bearing history; its retained tail prevents first-turn compaction while allowing compaction after the follow-up input. Image-priced pressure crosses the soft threshold while the otherwise identical text-only measurement remains below it.

The ACP protocol expectation is distinct from released Session generations: `stdout.expected.jsonl` asserts the current client-visible response. The image scenario requires `DONE`, not a summary accidentally consumed by the main request. Its protocol expectation follows verified corrected behavior while its released Session inputs remain immutable.

### Native Sidebar ownership and compound renderer keys

The [Sidebar assembly](../../../../packages/client/ui-sidebar-right/src/client/index.ts) associates each created store with its bound actions and adopts it through the native `inject(sessionId, actions)` arguments of either shared-store seat. Renderer factory keys are opaque Host/Session storage identities, not native Session ids. Treating them as native ids leaves the seeded guide without a committed occurrence because store actions write under the native id. Each instance acquires one adoption; store commits reconcile offscreen records, and plugin disposal releases subscriptions and aborts occurrences.

Parsing renderer keys or removing Host namespacing would couple the feature to private encoding or collide across Hosts. Allocating occurrences during render would bypass committed-record ownership. The [native-injection regression](../../../../packages/client/ui-sidebar-right/tests/apply.client.spec.ts) pins the first commit and header-first adoption; [real renderer and Session-adapter compositions](../../../../packages/client/ui-sidebar-right/tests/host-session.client.spec.tsx) verify independent stores, signals, actions, and disposal when two Hosts share native Session and tab ids. Built assembled-browser execution remains separate artifact verification.

### Worker preview responses

The Worker tunnel supplies the response methods used by the real Web carrier policy, including mutable headers, one-shot listeners, configurable lifecycle properties, and write/end callbacks. Completion emits finish before close; cancellation settles pending callbacks without publishing more tunnel frames. This repairs preview bundle HTTP 400 responses caused by policy installation against an incomplete synthetic response, without bypassing the policy or the route trust checks. Owner-local tests apply the production response policy to the synthetic exchange; the packed preview browser test remains the assembled acceptance.

### Workspace provisional rows

The [Workspace browser](../../../../packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx) applies its five-row quota only to non-blank Sessions. The selected provisional New Session remains visible at its ordered position without consuming that quota; the overflow control counts only rows actually hidden. After the first prompt makes the Session non-blank, it consumes the ordinary quota. Increasing the total slice by one would still hide a provisional row ordered beyond it, while counting the provisional row as hidden would misstate the overflow. Source regressions cover both ordered ends, exact and exceeded quotas, reopening, and the first-prompt transition; assembled browser acceptance remains separate.

### Model picker focus

The composer model picker transfers focus only after the portal placement is visible. Root, model-search, and effort panes own their initial focus; resize, scroll, and directory refresh do not reset user navigation. The regression models browser refusal to focus hidden measurement nodes, while the built model-picker discovery test retains its root Model autofocus assertion.

## Alternatives considered

**Refresh committed generations or normalize away new events.** Rejected because the former destroys released reader evidence and the latter removes strict verification of meaningful persisted output. A fabricated format increment would misstate the writer format.

**Treat current-format retention as historical migration coverage.** Rejected because it weakens the historical-version constraint and conflates reader migration with writer evolution.

**Change production job identities or share one retry sequence across request purposes.** Rejected because scenario determinism belongs in test composition, and title generation is not the main request under test.

**Disable the pruner or accept a replay without compaction.** Rejected because either would hide the post-prune threshold defect. Scenario budgets must permit the intended compaction, and the replay must still reach the final main response after summarizing the image history.

**Only wait longer for cache files.** Rejected because a later read does not repair checkpoint overtaking or expose a swallowed automatic-write rejection. Per-Session ordering and explicit write completion address separate obligations.

## Consequences

Some scenarios maintain both replay inputs and writer expectations. Their additional storage buys independent reader and writer assertions without weakening either. Corpus checks reject missing, extra, malformed-name, and wrong-version writer oracles; full-output replay remains mandatory.

The cache regression demonstrates checkpoint overtaking on Linux. It does not establish a Windows filesystem errno or fully explain the original Windows threshold-test failure. Hosted Windows execution remains the platform verification; local coverage is not a substitute.

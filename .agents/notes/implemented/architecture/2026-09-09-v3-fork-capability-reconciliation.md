# Agent Note: Retain fork capabilities on the canonical V3 runtime

Status: implemented

English | [中文](2026-09-09-v3-fork-capability-reconciliation.zh.md)

## Problem

Fork capabilities span request admission, Session reads, and Host-scoped Client state. Preserving their old implementations beside a different canonical Session format would create competing authorities for replay, token accounting, and connection ownership. Conversely, selecting upstream files wholesale would discard budgets, preflight admission, and Host isolation that remain product requirements.

## Decision

The fork uses the canonical V3 Session and persistence APIs. Durable assistant output is an embedded stream in `assistant/message` or `assistant/attempt`; live `agent/assistant-stream` frames do not create a second durable chunk log. System prompts are `system/message` history, not request-header payloads. Released generations remain immutable, with adjacent successors selected through the [format migration rules](2026-08-31-released-session-format-migrations.md). Consumers use canonical handle reads; retired raw-suffix readers are not restored.

Chat keeps a visible request-series card for a resume even when the system text is unchanged, including after older history is prepended. The card identifies the resumed request series; it does not inject another system prompt, and the reconstructed request retains one effective system node. This supersedes the presentation decision in [Resume headers do not repeat system prompts](../bug-fix/2026-09-03-resume-headers-do-not-repeat-system-prompts.md), while retaining its requirement to preserve durable resume headers. The [request-prompt projection](../../../../packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts) owns card visibility.

Budgets and exact prepared-call counters remain loop capabilities. Request preflight runs after route preparation and system/user/header commits, but before deriving the frozen request. Retry requires a newer declared replacement generation; productive replacement consolidates the system prompt and starts a request series. Provider-error recovery stays within the open step. Auxiliary compaction cannot evade accounting: budgeted agents refuse unaccounted model-backed summarization. The [core reference](../../../../docs/subsystems/core.md) and [lifecycle](../../../../docs/agent-lifecycle.md) own the detailed API and ordering.

Subagent teardown remains child-first and retains nested error causes so descendant quota classification and retry delays reach callers and parent notices. An ancestor interrupted before a step starts retains its durably restored task; pending input keeps the activation resident until explicit draining or another owning operation removes it. The [subagent reference](../../../../packages/subagent/subagent/README.md) owns teardown semantics, and the [continuation regressions](../../../../packages/subagent/subagent/tests/continuation.spec.ts) cover cause preservation and interrupted-input residency.

Host-scoped connection and Client state remain isolated while using the canonical manifests and transport APIs. `DshClientManifest.defaultRoot` expresses ordinary root exclusion without prohibiting explicit selection or dependency inclusion; omission keeps default inclusion. Its [typed author example](../../../../packages/util/package-manifest/README.md) and the [Client modules rules](../../../../packages/client/modules/README.md) share that declaration rather than duplicating a fork-only manifest type.

Remote uploads check their Host generation after reading the complete response body: checking only response headers allows a receipt from a disconnected generation to become visible. The [file-upload package](../../../../packages/client/file-upload/README.md) owns carrier selection and receipt admission. Source-plane package inventory first searches installed manifests, then uses the active Loader's ESM resolver when that search misses; it validates the resolved owning manifest's identity and propagates resolver errors other than missing modules. The [inventory package](../../../../packages/llm/plugin-package-inventory-deepseek/README.md) owns this resolution so source aliases do not require invented installation paths.

Imported reviewer routing and upstream Cloudflare preview publication are repository-scoped. They cannot request upstream reviewers or publish upstream previews from the fork. The independent hosted, keyless fork CI workflow remains enabled.

## Alternatives considered

**Retain parallel legacy storage and stream paths.** Rejected because two durable representations make replay, delivery watermarks, and token accounting depend on which consumer reads them.

**Select upstream implementations wholesale.** Rejected because format authority does not justify removing independent budget, admission, or Host-isolation requirements. Those features adapt to the canonical APIs instead.

**Resolve generated references by textual union.** Rejected because unioned types and sequence numbers can describe no executable implementation. Generators own catalogs; bilingual counterparts preserve the generated declarations and reviewed prose.

## Consequences

The fork retains its capabilities without a second Session authority. This requires updating every consumer and preserving historical fixtures alongside current-writer fixtures, rather than editing a released generation in place. Package pins and relative override importers remain package-manager-owned; a parseable hand-merged lockfile alone does not establish frozen-install compatibility. Migrated historical logs preserve request meaning but do not prescribe the native writer's event layout. The [packaged Python advanced scenario](../../../../python/development.md) opts into `writer.expected.jsonl` and `writer.<ordinal>.expected.jsonl` as complete current-writer oracles, while canonical `session*.jsonl` generations remain immutable. Its update path validates role inventories, current headers, and historical generations, then writes only writer oracles and `result.json`; strict comparisons reject payload, header, and role drift.

## Verification

Named verification obligations are loop budget/preflight behavior, V3 replay and SDK expectations, Host switching and subscription isolation, canonical persistence reads, the typed `defaultRoot` author example, and negative fork-governance guards. Generator freshness, type-equivalence, and translation pairing check the references, not runtime behavior. Native Windows containment, packaged runtime execution, real-provider calls, and browser-driven Host switching require their owning validation lanes; this note makes no claim that those lanes have completed.

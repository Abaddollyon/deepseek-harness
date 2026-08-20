# Agent Note: Unified session Agent flow

Status: implemented

English | [中文](2026-08-20-unified-session-agent-flow.zh.md)

## Problem

The Web client had a subagent catalog action, but no session-scoped view that combined retained subagent summaries, lazy membership catalogs, lineage diagnostics, provider/model identity, token usage, timing, and nested navigation. The external Swarm contribution supplied a competing persisted swarm view, so the core view needs one explicit registration and ownership decision to avoid duplicate views.

## Decision

@deepseek-ai/dsh-client-ui-subagent owns one `conversation.view` registration with persisted id `swarm`, localized label `subagent.view.swarm`, and order 25. It is registered through `ctx.slots.inject('conversation.view', () => ctx.slots.register(...))`, so the contribution follows the declaring slot and is removed with the plugin fiber. The package continues to own the header catalog action, read-only composer chain, and @ input source.

## Source audit and ownership

The source audit found the standard `useSessions` snapshot with `byId`, `subagentsByParent`, and `ids`; the runtime lineage index `indexSubagentDescendants`; lazy catalog methods `setSubagentCatalogOpen` and `refreshSubagents`; and the existing session-scoped `conversation.view` slot. The package already owns the catalog, diagnostics, navigation callbacks, locale namespace, and shipped web entry, so the flow is a presentation extension of that owner rather than a second catalog or runtime store.

The source audit also confirmed that `SessionSummary.parentId` is the client lineage field, while catalog navigation addresses are derived values. `ui-workflow-run` remains the owner of the workflow Conversation Definition and keyed Chat renderer; the flow does not import its renderer, definition, or panel.

## Data authority and merge precedence

AgentFlowView reads `byId`, `subagentsByParent`, and `ids` through the same framework-provided `useSessions` source. Subagent-origin summaries whose parent is represented are the lineage and lifecycle authority; ordinary forks terminate the subagent tree even when their descendants have subagent origin. `ids` is used only for the ordinary-open fallback and relies on the host-list invariant that addressed subagent rows are excluded, not on raw ids as proof of ordinary origin.

The pure model indexes subagent-origin summaries once, merges each parent catalog in stable source order, and lets summary lifecycle and projection values win. Healthy catalog entries provide mode, label, direct or aggregate activity, child hints, and catalog-first placeholders; a child address is derived from the catalog parent key, healthy child id, and mode. A retained `sessions.subagentAddress` value is used when a summary row has no current catalog entry. Diagnostic entries never receive an address.

The model retains a catalog-first healthy-child count when summaries lag, while aggregate running counts remain summary-backed. Catalog-only rows use direct activity before aggregate activity. Summary-only rows remain visible as disabled loading rows until a valid catalog or retained address exists; they may request refresh and ordinary open only when the summary is an eligible non-subagent host-list row.

## Lazy observation, cleanup, diagnostics, cycles, and orphans

The current session's catalog is observed on mount. Expanding a branch observes only that child parent; collapsing a branch closes it and every observed descendant, and session changes and unmount close every remaining observed parent through the latest callback ref. No polling or all-level hydration exists.

Healthy catalog entries, summary-backed rows, loading rows, catalog load errors, and corrupt, unsupported, and unavailable diagnostics remain separate stable rows. Diagnostic, loading, cycle, and orphan cases cannot create an open action. A cycle stops that branch with a localized lineage diagnostic; an orphan summary remains out of the root tree until its parent is represented while remaining safe for aggregate indexing.

## Metrics and render-cost constraints

Token total is the disjoint sum of `uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. Model identity uses `modelRoute.provider` and `modelRoute.model`; a partial route shows the known side and an unavailable value for the other, while `agentPreset` is shown only as an explicitly named preset fallback. Missing projections render localized unavailable values rather than fabricated zeros.

Active duration is `subagentTiming.settledMs` plus the active interval; a running interval ends at the shared current clock, and a settled or inactive interval ends at `active.through`. The flow reports only running or settled state. `SessionSummary cannot report durable success/failure outcome`; the UI therefore does not claim success, failure, cancellation, or completion.

One component-local one-second clock serves all visible active rows. Structural/catalog/summary model facts are memoized independently of the clock; only active-duration presentation receives a changing time value, so settled rows retain stable render inputs. The flow mounts only the root and explicitly expanded levels and does not create a timer or subscription per row.

## Slot registration and external Swarm migration

The core package registers the `swarm` view for every session, including an empty session, through the declared session-scoped slot. The external `@arro/dsh-swarm-ui` contribution is a rollout prerequisite owned by the orchestrator: it must be removed or disabled before shipping this core registration. This core change does not edit the extensions worktree, a profile, deployment composition, installed runtime, service, or port 3080.

## WorkflowRunPanel retention and patch-anchor audit

The existing Chat workflow card remains owned by `WorkflowRunPanel` in `@deepseek-ai/dsh-client-ui-workflow-run`. The Swarm flow is an index and navigation surface only: it opens child sessions and does not duplicate workflow runs, phases, members, outcomes, or disclosure state. The ui-workflow-run source and tests remain unchanged by this feature.

A read-only audit of `/home/arro/coding/deepseek-harness-extensions/patches/manifest.json` found patch id `apply-rc6-workflow-card`, targeting `dsh-client-ui-workflow-run/lib/client.js`. Its two protected find strings matched exactly once and the replacements remained unchanged:

~~~json
{
  "find": "\t\tif (member.status === \"running\" && ordinary.has(member.childId) && summary?.origin === \"subagent\" && summary.parentId === parentId && summary.running) result.push(member.childId);",
  "replace": "\t\tif (ordinary.has(member.childId) && summary?.origin === \"subagent\" && summary.parentId === parentId && (summary.running || member.status !== \"running\")) result.push(member.childId); // rc6-workflow-card patch",
  "count": 1
},
{
  "find": "\t\t\t\tstatus: member.outcome === void 0 ? interrupted ? \"interrupted\" : \"running\" : statusFromOutcome(member.outcome)",
  "replace": "\t\t\t\tstatus: member.outcome === void 0 ? (interrupted || locationClosed(location) ? \"interrupted\" : \"running\") : statusFromOutcome(member.outcome)",
  "count": 1
}
~~~

The two protected find values and their replacements match the external manifest exactly, each with count 1. No extension file or patch manifest was edited, and no patch replacement is required for this core feature.

## Alternatives considered

**Keep the external Swarm view and add only core data helpers.** Rejected because two Swarm registrations would duplicate the persisted view and leave ownership ambiguous. The core package owns the view while rollout owns external disablement.

**Add a new view id instead of reusing `swarm`.** Rejected because persisted view identity and existing navigation use `swarm`; a new id would create a second surface instead of replacing the external view.

**Add a runtime lineage service or a per-child RPC.** Rejected because the same `useSessions` snapshot already carries summary lineage and lazy catalogs. A presentation-only projection does not justify moving business data into runtime or adding one request per row.

**Use the catalog as the only source or compute live duration in the structural model.** Rejected because catalog-first rows can precede summary hydration, and clock ticks would rebuild every structural row. The implementation merges both sources and isolates dynamic duration presentation.

**Open every row through `openSession`.** Rejected because catalog-backed children require the exact parent/child/mode address and `openSubagent`; ordinary fallback is limited to the host-list exclusion invariant.

## Consequences

The flow is available for every session and has an explicit empty state instead of a member-count threshold. A healthy catalog child is visible before `byId` catches up, and diagnostics remain visible without becoming navigable. The view exposes provider/model and optional usage/timing/stat facts without creating new subscriptions or RPCs.

The aggregate running count remains summary-backed, so a catalog-only running child can show running row state before the summary aggregate catches up. Catalog load failures add a retryable inert row. Root and expanded-parent catalog observations remain local component state and are closed on teardown, which prevents stale open membership subscriptions across session changes.

The external rollout prerequisite remains operational work: until the orchestrator disables `@arro/dsh-swarm-ui`, the deployed composition must not mount both registrations. The core package does not own that external migration and cannot verify deployed composition from this repository.

## Testing and snapshot evidence

`packages/client/ui-subagent/tests/agent-flow.client.spec.tsx` covers empty sessions, nested summary/catalog merging, catalog-first aggregate fallback, token-bucket summation, active-through duration, loading placeholders, diagnostics, retry, addressed navigation, accessibility metadata, and cycle prevention using `createSnapshotStore` and `bindSnapshotSelector`. `packages/client/ui-subagent/tests/browser-plugin.client.spec.ts` boots a real `SlotRegistry`, verifies the Swarm registration and injected navigation face, and proves fiber disposal removes the view. The focused regression command retains the conversation UI and workflow-run suites.

The assembled keyless browser evidence uses `DSH_SNAPSHOT=replay pnpm run test:web` after the client build. Refresh mode is used only for committed ARIA goldens whose reviewed diff is the registered Agents tab in the tab strip or the new Swarm flow view; replay fixtures and unrelated goldens remain unchanged. The built-boot official-brand mismatch remains the sole expected red because the official-brand scenario is pre-existing and is not refreshed.

The view-level evidence includes the Agents tab registration and the component flow fixtures; the existing WorkflowRunPanel regression remains separate because workflow details stay in Chat. The refresh wrote exactly 41 files: `apps/web/tests/snapshots/bash-abort-row/ui.expected.md`, `apps/web/tests/snapshots/code-mode-round/ui.expected.md`, `apps/web/tests/snapshots/cordis-tool-round/ui.expected.md`, `apps/web/tests/snapshots/feedback-command/ack.expected.md`, `apps/web/tests/snapshots/fresh-round-trip/ui.expected.md`, `apps/web/tests/snapshots/goal-command-presentation/ui.expected.md`, `apps/web/tests/snapshots/goal-multi-turn-actions/ui.expected.md`, `apps/web/tests/snapshots/lifecycle-chrome/reloaded.expected.md`, `apps/web/tests/snapshots/live-interactions/cancel.expected.md`, `apps/web/tests/snapshots/live-interactions/error-auth.expected.md`, `apps/web/tests/snapshots/live-interactions/loading.expected.md`, `apps/web/tests/snapshots/live-interactions/retry.expected.md`, `apps/web/tests/snapshots/markdown-cjk-strong/ui.expected.md`, `apps/web/tests/snapshots/markdown-images/ui.expected.md`, `apps/web/tests/snapshots/markdown-inline-code-links/ui.expected.md`, `apps/web/tests/snapshots/math-rendering/ui.expected.md`, `apps/web/tests/snapshots/message-actions/ui.expected.md`, `apps/web/tests/snapshots/plan-review/approved.expected.md`, `apps/web/tests/snapshots/question-composer/answered.expected.md`, `apps/web/tests/snapshots/queue-actions/collapsed.expected.md`, `apps/web/tests/snapshots/queue-actions/editing.expected.md`, `apps/web/tests/snapshots/queue-actions/layout.expected.md`, `apps/web/tests/snapshots/queue-actions/preserved.expected.md`, `apps/web/tests/snapshots/queue-actions/ui.expected.md`, `apps/web/tests/snapshots/reference-composer/order.expected.md`, `apps/web/tests/snapshots/seeded-history/command-row.expected.md`, `apps/web/tests/snapshots/seeded-history/feedback-row.expected.md`, `apps/web/tests/snapshots/seeded-history/ui.expected.md`, `apps/web/tests/snapshots/skill-tool-row/ui.expected.md`, `apps/web/tests/snapshots/skill-user-invoke/ui.expected.md`, `apps/web/tests/snapshots/stats-paged-history/ui.expected.md`, `apps/web/tests/snapshots/steer-all/mid-steer.expected.md`, `apps/web/tests/snapshots/steer-all/settled.expected.md`, `apps/web/tests/snapshots/steering/mid-steer.expected.md`, `apps/web/tests/snapshots/steering/settled.expected.md`, `apps/web/tests/snapshots/subagent-conversation/nested.expected.md`, `apps/web/tests/snapshots/subagent-conversation/ui.expected.md`, `apps/web/tests/snapshots/subagent-interrupt/offline-composer.expected.md`, `apps/web/tests/snapshots/turn-tail-actions/running.expected.md`, `apps/web/tests/snapshots/turn-tail-actions/settled.expected.md`, and `apps/web/tests/snapshots/web-search-round/ui.expected.md`. Every hunk adds only `tab "Agents"` between the existing tabs; no flow-view body, JSONL fixture, or unrelated content changed, and the built-boot official-brand golden stayed excluded.

## Supersession and unchanged behavior

The feature extends the following decisions without changing their runtime or durable contracts:

1. [Durable subagent catalog and list_agents](2026-07-22-durable-subagent-catalog-and-list-agents.md) — **extended:** the client presents the catalog's healthy children and diagnostics in a nested session view. **Unchanged:** catalog entry kinds, diagnostic reasons, stable child identity, and model-facing list behavior.
2. [Web subagent conversations](2026-07-27-web-subagent-conversations.md) — **extended:** the existing catalog and navigation owner now supplies a session-scoped Swarm index. **Unchanged:** addressed navigation, read-only one-shot behavior, composer routing, and offline limitations.
3. [Continuable subagent conversations](2026-07-28-continuable-subagent-conversations.md) — **extended:** the flow renders one-shot and continuable descendants at hydrated depths. **Unchanged:** Activation, inbox, exact-direct-parent authorization, and continuation lifecycle.
4. [Continuable subagent interrupt](2026-08-06-continuable-subagent-interrupt.md) — **extended:** running/settled presentation identifies live children without adding controls. **Unchanged:** the dedicated interrupt route, one-shot non-cancellability, and Stop/Send behavior.
5. [Durable workflow runs in Chat](2026-08-10-durable-workflow-runs-in-chat.md) — **extended:** workflow workers become navigable index rows when current session facts permit. **Unchanged:** durable workflow events, member eligibility, and the original tool row.
6. [Workflow-run status-driven disclosure](2026-08-11-workflow-run-status-driven-disclosure.md) — **extended:** the Swarm view links to the Chat drill-in. **Unchanged:** WorkflowRunPanel disclosure state and phase/status derivation.
7. [Workflow per-agent reasoning effort](2026-08-19-workflow-per-agent-reasoning-effort.md) — **extended:** the flow can show the resulting provider/model identity while retaining the existing workflow route. **Unchanged:** per-agent reasoning-effort selection, validation, and worker execution.
8. [Conversation render cost bounds](../architecture/2026-08-19-conversation-render-cost-bounds.md) — **extended:** the flow applies the shared render-cost discipline with stable structural rows and one active-duration clock. **Unchanged:** the conversation package's existing cache bounds, settings, and scroll/render contracts.
9. [Subagent list identity via the projection unit](../architecture/2026-08-06-subagent-list-identity-projection.md) — **extended:** the flow consumes the published subagent identity projection for mode and label precedence. **Unchanged:** projection fold authority, diagnostic mapping, sequence validation, and compute-and-discard policy.

These links record the prior decisions this view extends; none of the linked notes is edited or archived by this change.

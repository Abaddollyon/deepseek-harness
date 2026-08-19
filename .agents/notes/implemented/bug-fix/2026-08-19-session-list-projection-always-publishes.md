# Agent Note: The Session list projection publishes every pass

Status: implemented

English | [中文](2026-08-19-session-list-projection-always-publishes.zh.md)

## Problem

`SessionRuntime.projectList` rebuilds the Session list store from the manager snapshot. Teaching it to project nested subagent branch activity also gave it per-field identity reuse — reused `ids`, `byId`, row, `subagentsByParent`, `jobsBySession`, and `currentAddress` references — and, alongside it, an early return that skipped `list.set` entirely whenever every projected value held. Identity reuse is what keeps a catalog refresh from remounting sidebar rows; the skipped publish was a separate behavior change, and it silently removed a notification client surfaces rely on.

The manager notifies for gestures that move no list value. `sessions.open(id)` on the session that is already current is one — `SessionManager.select` ends in `notifier.notifyNow()` — and `workspaces.startSession()` produces it whenever `connectWorkspace` reuses the current blank session instead of creating one. With the publish suppressed, whoever waited for that gesture never heard it. The agent-presets settings section stages `cordis` on the hero chip and then starts a session, and the chip applies a staged pick from its list subscription; on a connected Workspace whose blank session was already current, nothing ever applied the stage and the flow produced a session on the deployment default instead of the creator composition.

## Decision

`projectList` always publishes: it builds the next state from the stabilized fields and calls `list.set` on every pass, including a pass whose values all held. Identity reuse is untouched, and it is what bounds the cost — a consumer reading rows, catalogs, or the id list bails out on the unchanged reference, so an equivalent projection remounts nothing. The store keeps its own dedupe semantics: it skips notification only when the whole state object is identical, which a fresh projection never is.

The projection remains the only publisher of the list store, and no caller learns why the manager flushed. A gesture that lands on an unchanged list is therefore observable exactly like any other pass, which is what the surfaces waiting for a session to arrive need.

## Testing

`packages/client/runtime/tests/sessions-service.client.spec.ts` pins both halves: the existing case still requires an equivalent refresh to reuse every field identity, and a new case opens the already-current session and requires the list subscriber to be notified once while `ids` and `byId` keep their references.

`apps/web/tests/agent-preset-authoring.e2e.ts` covers the flow end to end: its creator-mode scenario polls `session.list` for the session the settings entry started and requires `agentPreset: 'cordis'`.

## Alternatives considered

**Apply the staged preset from the creator entry instead of the list subscription.** The entry would have to judge for itself whether the current session can take the pick, before `workspaces.startSession()` — a fire-and-forget call — has resolved the session the flow actually lands on. It would apply the composition to whatever blank session happened to be current, including one the connect is about to leave behind, and the seat controller's rule that a started session drops the stage would move into the caller.

**Publish only for synchronous gesture flushes and keep suppressing batched convergence.** This needs the shared `Notifier` to tell listeners why it flushed, which `Session` uses too, for a saving the field identity reuse already delivers.

**Keep the suppression and treat the creator-mode e2e as obsolete.** The scenario pins current product behavior — a settings gesture that lands on a composed session — and nothing about projecting nested subagent activity changes what that flow owes the user.

## Consequences

An equivalent projection costs one `list.set` and one notification per pass, so a subscriber keyed on snapshot identity re-renders even when nothing moved; every field beneath it keeps its reference, so the work stops at that read.

Surfaces may again treat a list notification as "the current session may be servable now", which is how the agent-preset hero chip, and any later flow that stages before starting a session, reach the session they land on.

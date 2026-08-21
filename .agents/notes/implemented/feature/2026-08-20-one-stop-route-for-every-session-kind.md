# Agent Note: One stop route for every session a human can open

Status: implemented

English | [中文](2026-08-20-one-stop-route-for-every-session-kind.zh.md)

## Problem

A human could open a subagent conversation in the GUI and have no way to stop it.

`session.cancel` fenced any subagent-owned session outright, answering an ownership error rather than cancelling, on the reasoning that a child's turns belong to its parent. The composer agreed: its primary Send/Stop toggle was suppressed for a child, and the independent Stop control appeared only for a *continuable* one. A one-shot child therefore presented no stop affordance at all, and the client's own `cancel()` carried a hard-coded failure for that case. The documented route was `job_kill`, which is a model-facing tool the GUI does not offer.

That is D10 of the interruption investigation, and it sat on top of the two defects the [cancellation-convergence note](../bug-fix/2026-08-20-cancellation-convergence-across-the-agent-tree.md) records: a stop that did not reach the subtree, and a settling child that re-opened the stopped turn.

## Decision

**The ownership fence becomes a cause selector, not a refusal.** `session.cancel` now cancels whatever session the human named, choosing the cause from ownership rather than declining: `{ kind: 'parent' }` when the session is subagent-owned, `{ kind: 'user' }` otherwise, both with `keepInbox: true`. The owner's own Agent is untouched — stopping a child is not stopping its parent — and the durable cause stays honest about who asked and on whose behalf.

**The cascade rides the same call.** `ctx.get('subagents')?.cancelDescendants(sessionId)` follows the cancel, so a human stop reaches the whole live subtree below the named session whatever kind of session it is. The optional-service read keeps a subagent-less composition working unchanged.

**The composer offers Stop to every live child.** The independent Stop control is no longer gated on continuability, so a one-shot child is stoppable through the same gesture as any other session.

## Alternatives considered

**Route the GUI through `subagent.interrupt` for children.** Rejected: that endpoint authorizes a *durable parent address*, which the composer does not always have — a one-shot child's parent may be offline — and it is the model's single-target primitive, whose documented reach is deliberately narrower than a human stop. Making the human path go through it would have forced one of the two meanings to bend.

**Keep the fence and expose `job_kill` in the GUI.** Rejected: a job id is an implementation detail of one-shot background delegation, and a control that stops some children through one mechanism and others through another is a UI that has to explain the harness's internals to its user.

**Cancel the owner too, so the parent stops asking.** Rejected: the human named a child. A stop that silently ends the parent's turn destroys work the user did not address, and the parent's own stop control is one click away.

## Consequences

Every session a human can open now has exactly one stop route with one meaning: stop this session and everything live below it, keep the queue, leave the owner alone. A subagent-owned session's durable `turn/end` records `{ aborted, parent }` rather than `{ aborted, user }`, which keeps the cause faithful to the lineage while still being a human-initiated stop; consumers that distinguish a user stop — the settlement-notice predicate among them — read the cause, so a stopped child's parent is still woken normally when that child settles, which is correct: the parent did not stop.

# Agent Note: Inbox durability across aborts and lifecycle teardown

Status: implemented

English | [中文](2026-08-25-inbox-durability.zh.md)

## Problem

The agent loop claims its step batch through durable pure-deletion inbox splices BEFORE system-prompt assembly and the `agent/pre-step` waterfall run. When the turn signal aborted anywhere in that window, the claimed messages had already left every pending list and no model request ever saw them: they vanished with the aborted turn. Two lifecycle paths compounded the loss — the agent-loop disposal transaction cancelled with the default options and the goal-round-driver teardown cancelled with `{ kind: 'parent' }`, both of which clear the pending inbox and log canceled splices, so queued user input was discarded at exactly the moments a session is about to be resumed later.

## Decision

An abort raised after the claim and before the step starts now restores the unstarted claimed batch to the inbox inside `ReactLoopAgent.preStep`. Restoration prepends each message to the list it was claimed from — next-step input ahead of newer steering, one queued prompt ahead of newer follow-ups — and skips any message already pending, so a listener that re-queued or restored the batch itself never produces a duplicate. A non-abort pre-step failure stays terminal with the batch removed: rejecting listeners already restore what they keep, and silently re-queueing would replay a rejected proposal.

Both lifecycle teardown paths pass `{ keepInbox: true }`: the agent-loop disposal transaction (`{ kind: 'disposed' }`) and the goal-round-driver teardown (`{ kind: 'parent' }`). Pending inbox work is durable session state replayed by every resumed lifecycle, not runtime residue; teardown interrupts the active turn but no longer discards input it never claimed. The [explicit-cancellation decision](../architecture/2026-07-16-explicit-turn-cancellation.md) owns the cancellation vocabulary and the [cancel-convergence wake latch](2026-08-07-cancel-convergence-wake-latch.md) owns how waking input races an abort; this note owns what survives them.

## Alternatives considered

**Restore only when the cancel passed `keepInbox`.** Rejected because the abort signal carries only the typed cause, and an explicit user cancel would keep silently dropping a claimed message that no request ever saw — the exact loss window this change closes.

**Delay the durable claim until assembly and listeners succeed.** Rejected because the `agent/pre-step` payload must carry the exclusively claimed batch, and keeping the messages pending through the waterfall would let a second claimant observe them, breaking the exclusive-ownership transfer the claimed notification publishes.

**Let each listener keep restoring its own messages.** Rejected because only the loop sees every claimed message; a listener that restores selectively (the goal-round-driver keeps its own reservation out) cannot prevent the rest from vanishing.

## Verification

`packages/core/agent-loop/tests/inbox-durability.spec.ts` pins an abort during pre-step restoring a claimed waking message and claimed steering (each rerunning on the next wake), the no-duplicate skip when a listener re-queues first, and a pending inbox surviving disposal into a resumed lifecycle over JSONL persistence. The goal-round-driver suite pins queued human work surviving driver teardown, and the subagent continuation suite pins a teardown settlement notice surviving the parent's disposal as pending input.

## Consequences

A prompt whose turn aborts before its first step runs is no longer lost: it is claimed again by a later turn or by a remounted lifecycle. Disposal and goal-driver teardown leave the pending inbox intact in the durable log, so resume continues where the session stopped instead of starting from a silently shortened queue. Callers that genuinely intend to drop pending work still can: an explicit `cancel()` without `keepInbox` clears pending input, and only the unstarted claimed batch returns.

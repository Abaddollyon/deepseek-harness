# Agent Note: Workflow Terminal Members Stay Navigable

Status: implemented

English | [中文](2026-08-25-workflow-terminal-member-navigation.zh.md)

## Problem

A member row in the durable workflow Chat node could open its child Session only while both the member's durable status and the list row were still running. The moment a member completed, failed, or was interrupted, its row went static — even though the child Session usually still sat in the ordinary Session list and `sessions.open(id)` works on a finished child exactly as on a live one. Reviewing a finished run, the primary use of a durable run record, meant hunting the child down in the session sidebar by hand.

The gate was doubly unfortunate because the run record already projects outcome-less members of a closed location to `interrupted`: a process stop turned every still-running member static at once, precisely when the user most needed to inspect what each child had done.

## Decision

`navigableMembers()` in `ui-workflow-run`'s `WorkflowRunPanel` no longer gates on lifecycle. A member is navigable whenever the ordinary Session list contains its child id with `origin: 'subagent'` and `parentId` equal to the displayed parent — the three identity proofs are unchanged. The member's durable status and the list row's `running` flag no longer participate: they describe whether work is live, not whether the child Session can be opened.

This partially supersedes [Durable workflow runs in Chat](../feature/2026-08-10-durable-workflow-runs-in-chat.md), which rejected terminal navigation on the grounds that the workflow record proves historical identity, not current accessibility. That objection is answered by the gate's remaining half: accessibility comes from the current ordinary list, never from the record. A row the list contains is openable through the same injected `sessions.open(id)` the sidebar uses; a row the list does not contain — remote, addressed-only, or wrong-parent — stays static, so the node still grants no cold-session or cross-remote opening promise.

The focused-member retention in `MemberRow` is unchanged but its trigger moved: a focused button now loses navigability when the child row leaves the ordinary list, not when the member settles.

## Alternatives considered

- **Keep the running gate.** Rejected: it made the durable record self-defeating — the members most worth reviewing (finished, interrupted) were exactly the ones that could not be opened, while the identity proofs that actually make opening safe were already enforced.
- **Persist navigability into the run record** (for example an `openable` flag at member end). Rejected: navigation must follow current list facts, not history; a persisted yes would keep a deleted or filtered-out child falsely interactive, and a persisted no could never be revoked by the row returning.

## Consequences

Completed, failed, cancelled, and interrupted members open their child Session while its ordinary-list row exists, including after a page reload. Navigation can still vanish as list facts change — the row leaving the ordinary list reverts the member to static text — so the disclosure lifecycle's deferred-close reasoning in [Workflow run status-driven disclosure](../feature/2026-08-11-workflow-run-status-driven-disclosure.md) keeps its mechanism with the moved trigger.

Component tests cover a completed and an interrupted member opening their settled children and a member without a child Session row staying static; the shipped-Web replay now asserts the settled member is a button that opens the child, live and after reload, where it previously asserted the opposite.

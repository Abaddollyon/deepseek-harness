# Agent Note: Workflow agent() Labels Reach the Child Session

Status: implemented

English | [中文](2026-08-25-workflow-agent-label-persistence.zh.md)

## Problem

`agent(prompt, { label })` has always accepted a display label, and the durable run panel shows it on the member row. But the label never crossed the worker→host thread boundary: `ChildStartRequest` had no label field, the worker runtime computed the label for its observer narration and then omitted it from the `child-start` payload, and the host's `subagents.start` call passed no label — even though `SubagentStartRequest.label` already persists one into the child's durable descriptor. Workflow child Sessions therefore appeared in the session sidebar under a bare session id while the run panel beside them showed the member's real name.

## Decision

The label now travels the path [per-agent reasoning effort](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) established for per-call options: an optional `label` on `ChildStartRequest` (which the `child-start` protocol payload carries verbatim), forwarded by the worker runtime, and passed by the host into `subagents.start`, which persists it into the child's descriptor. The sidebar already consumes that descriptor — the subagent list-children projection folds it and the client session-list projection displays `child.label ?? childId` — so no client change was needed.

Only the script's explicit `label` option travels. The prompt-derived label the runtime computes for observer narration on unlabelled calls stays run-local: an unlabelled `agent()` call produces exactly the durable descriptor it produced before, and its sidebar row keeps the session-id fallback. The wire field is optional end to end, so a peer that never sends one is tolerated unchanged.

## Alternatives considered

- **Forward the prompt-derived label for unlabelled calls too.** Rejected: it would rewrite every unlabelled child's durable descriptor and sidebar title for no expressed intent, and the gap being closed is the explicit label going missing, not the documented fallback the run panel and sidebar already share.
- **Keep labels run-local and derive sidebar titles from the parent's run record.** Rejected: it couples the session list projection to workflow internals across a package boundary, when the subagent seam already owns exactly this channel.

## Consequences

A labelled workflow child is named consistently in the run panel and the session sidebar, including after reload, because the label lives in the child's own durable descriptor rather than in either projection. Out-of-process backends that ignore the start request's label ignore it here exactly as they ignore it for tool-delegated children; the field is data, not a capability.

Worker-thread tests pin both directions over the in-process protocol — an explicit label forwarded, an unlabelled call sending none — and the real-worker host test asserts the label lands on the provider-visible start request while the unlabelled sibling stays label-free.

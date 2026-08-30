# Agent Note: Awaited session flush at agent teardown

Status: implemented

English | [中文](2026-08-25-teardown-session-flush.zh.md)

## Problem

The persistence coordinator is write-behind: `session/event` appends open a bounded batching window and only a `session/flush` barrier or backend teardown drains them immediately. The session-checkpoint-policy flushes before model, tool-dispatch, and next-step boundaries, but nothing covered a final append — a settled tool result, the closing `step/end`/`turn/end` — followed straight by agent disposal. The coordinator does drain a disposed session's controller on `session/disposed`, yet that retirement is observe-only: nothing awaits it, so a resolved `dispose()` was never a durability barrier and a process exiting at the teardown edge could lose the driver's closing records.

## Decision

The agent-loop disposal transaction now awaits `ctx.sessions.flush(agent.session)` after the driver reaches quiescence and before the agent scope unwinds, ahead of the session detach that emits `session/disposed`. A settled `dispose()` therefore means the closing events of every finished turn have reached the durability listeners. The flush is best effort: a listener failure is logged as a warning and teardown proceeds, because disposal is a lifecycle obligation that must not break on a storage fault — the coordinator's own unawaited retirement drain remains as the fallback.

## Alternatives considered

**Await the coordinator's retirement instead.** Rejected because retirement is a notification-side effect owned by the persistence plugin; making the store's disposal path await it would couple the lifecycle owner to one listener's bookkeeping and still leave non-coordinator durability listeners (`session/flush` subscribers generally) outside the barrier.

**Flush before `whenIdle()`.** Rejected because the driver's closing records — the final tool/result and the turn's terminal boundaries — commit during the abort-to-idle convergence; only a flush after quiescence observes them.

**Propagate flush failure.** Rejected because teardown runs on every unload path, including error recovery; a storage fault must not strand the agent in its registries or break the composing fiber's disposal, and the failure is still surfaced through the logger.

## Verification

`packages/core/agent-loop/tests/teardown-flush.spec.ts` pins both halves: disposal dispatches a flush that already observes the settled `tool/result` and does not settle until that flush resolves, after which a remounted persistence backend reads the tool result and closing turn boundary back; and a rejecting flush listener downgrades to a logged warning while disposal still completes and unregisters the agent.

## Consequences

Handle disposal, caller-fiber unload, and provider unload all converge on the memoized teardown, so every agent exit path now carries the same durability barrier. Deployments that dispose agents and immediately exit — automation runs, scoped subagent hosts — can no longer lose the final settled records of the turns they owned.

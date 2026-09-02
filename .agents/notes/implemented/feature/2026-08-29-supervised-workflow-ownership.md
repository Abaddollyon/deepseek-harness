# Agent Note: Supervised workflow ownership

Status: implemented

English | [中文](2026-08-29-supervised-workflow-ownership.zh.md)

## Problem

The workflow tool previously owned every run until the calling tool step settled. That is correct for foreground use, but Code Mode aborts a nested tool signal as soon as its program returns; a workflow could not outlive that step. Detaching without another bound would instead create an unbounded worker, and a process restart would leave the durable workflow card open.

## Decision

`dsh-tool-workflow` adds `ownership: caller | supervisor`, defaulting to `caller`. Caller ownership preserves the existing request signal, abort bridge, return shape, errors, disposal order, and model-facing description. Supervisor ownership omits the caller signal, preallocates the run id, and calls `jobs.startDurable` with the stable `workflow-${runId}` job id, durable owner Session identity, and no resume specification. The workflow producer starts only after the initial job record commits; the tool then appends `run/detached` and returns `{ runId, jobId, status: "running" }`. The job cancel hook calls `WorkflowRun.cancel`; its final-output promise awaits the result and disposal before closing the recorder and exposes the existing bounded completion rendering through `job_output`.

A supervised workflow is deliberately non-resumable. Boot reconciliation synthesizes `tool-workflow/agent-end` with `cancelled` for each unpaired member, then `tool-workflow/run-end` with `cancelled`, then `run/abandoned`. The order keeps the workflow invariant valid and moves the durable card out of running state before the model-visible abandonment account.

The WorkflowEngine Definition exposes the provider's resolved `maxRunWallMs`. Supervisor ownership fails at plugin load when that value is zero or Jobs is absent. This avoids duplicating worker-thread Config while making an unbounded handoff impossible. `JobKindMap` gains `workflow` through its public declaration-merge subpath; workflow registers no resumer.

This note partially supersedes the execution-ownership conclusion in [Durable workflow runs in Chat](2026-08-10-durable-workflow-runs-in-chat.md). That note remains authoritative for recording and rendering; this note owns the optional runtime handoff.

## Verification

Focused tests pin the unchanged caller path, load-time topology failures, the immediate supervisor result and detached event, non-resumable job metadata, final-output settlement after disposal, and `job_kill` reaching run cancellation. Existing worker-thread cancellation tests pin the shared child AbortController, parent-cancellation taxonomy, grace timer, forced termination, and stranded-member synthesis. Run-supervisor tests pin offline closer ordering and the no-detached fallback. Changed executable files meet per-file 100% coverage.

## Alternatives considered

**Duplicate `maxRunWallMs` in tool Config.** Rejected because two configured limits could disagree; the engine is the execution authority and now publishes its resolved value.

**Register a workflow resumer that reruns script and args.** Rejected because children may already have produced side effects. Re-execution is not continuation and is not generally idempotent.

**Keep one output schema with optional foreground/background fields.** Rejected because it would change caller-visible semantics. The tool builds the exact schema for the configured ownership.

## Consequences

Deployments can choose foreground shared fate or an owner-scoped background job without changing script syntax. Supervisor workflows survive the calling step but not host restart; restart is represented honestly and closes durable UI state. Job output remains bounded, explicit kills do not produce a redundant completion wake-up, and owner disposal still reaps the run through the Jobs registry.

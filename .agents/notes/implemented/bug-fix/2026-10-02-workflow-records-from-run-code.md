# Agent Note: Workflow records from run_code

Status: implemented

English | [中文](2026-10-02-workflow-records-from-run-code.zh.md)

## Problem

`dsh-tool-workflow` wrote its durable `tool-workflow/*` record only for root tool calls (`exec.parent` absent), on the grounds that a nested transport call owns no Chat row of its own ([durable workflow runs in Chat](../../archived/feature/2026-08-10-durable-workflow-runs-in-chat.md)). In PTC mode `run_code` is the only top-level tool, so the model reaches `workflow` solely through a `run_code` dispatch. Every foreground run there left no record, and Chat and any Session-derived workflow view never showed it.

## Decision

Every accepted `workflow` call records its run in the calling Agent's Session, including a call dispatched from `run_code`. `exec.parent` is set only by the `run_code` bridge; workflow scripts start child Agents rather than dispatching tools, and a child's own calls are root calls in its own Session, which upstream already recorded. The Chat node anchors at `tool-workflow/run-start`, which a dispatched run appends inside the open `run_code` call, so it appears after that call's row like a root run does after its own.

## Alternatives considered

**Keep root-only recording and expose `workflow` beside `run_code`.** That widens the PTC-mode tool surface, which exists to keep a single top-level tool, and still loses runs the model chooses to dispatch.

**Identify the parent tool from its token.** The token is deliberately opaque, and `run_code` is its only producer, so the extra lookup would add an API without changing any outcome.

## Consequences

PTC-mode workflow runs survive refresh like root runs. A future composite transport that sets `exec.parent` and wants no record must add its own condition here.

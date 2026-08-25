# Agent Note: Goal round teardown owns its claimed prompt

Status: implemented

English | [中文](2026-08-30-goal-round-teardown-ownership.zh.md)

## Problem

The goal-round driver can be unloaded while its automatic prompt is claimed and blocked in the agent pre-step waterfall. Agent cancellation preserves pending inbox input, but restoring the driver's own claimed prompt would replay an attempt whose authority has already been disarmed.

## Decision

Before returning from an aborted goal pre-step, the driver removes its exact claimed prompt from the shared claimed batch. Agent-loop cancellation can then restore only other claimed messages. Foreign human input remains pending and resumes through the next lifecycle.

## Alternatives considered

**Keep the claimed prompt for agent-loop restoration.** Rejected because the goal driver has already disarmed the attempt; restoration would replay automatic work without an armed goal authority.

## Verification

`packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts` blocks a goal pre-step, queues foreign human input, tears down the driver, and asserts that only the human message survives. The goal prompt is not replayed.

## Consequences

Goal teardown is idempotent with agent-loop inbox restoration: the driver owns removal of its attempt, while agent-loop owns preservation of unrelated claimed input.

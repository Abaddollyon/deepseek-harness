# Agent Note: Session list and navigation recovery

Status: implemented

English | [中文](2026-09-13-session-list-and-navigation-recovery.zh.md)

## Problem

Overlapping session-list requests can duplicate cold title observations and discard useful results when another observation replaces their cache entries. Splitting a title observation into sixteen-session calls also repeats the complete persistence listing for each call. Under load, this background work competes with history, workspace streams and commands.

A subagent list row can precede its direct-parent catalog. Opening that row with only its session id violates the history controller's durable-address requirement. Delayed workspace mutation responses can replace newer streamed state, including rows with equal millisecond timestamps. A rejected model selection can leave its controls permanently busy.

## Decision

The list controller reserves uncached titles before starting one query observation. The query provider owns bounded persisted-read concurrency and releases each full log after projection. Overlapping list requests share reservations; cancellation and failure release them for subsequent retries. Cache identity continues to fence lifecycle replacement and stale completions.

Subagent navigation resolves the direct-parent catalog before publishing a current child session. Pending navigation respects subsequent user selection and child removal. Workspace mutation echoes are fenced by intervening stream or baseline updates. Model selection releases its busy state on rejection and prevents an obsolete generation from changing current controls.

## Alternatives considered

Increasing reconnect timeouts would leave duplicated history work and stale-state races intact. Opening a child as an ordinary session would weaken the durable parent requirement. Keeping sixteen-session title calls would preserve early partial title publication but repeatedly list the entire corpus; one observation retains the provider's read limit without those extra listings. A persistent title index would reduce future cold-start work further, but requires a separate invalidation and storage design.

## Consequences

Titles publish after the reserved observation completes, so one slow history can delay titles in that observation; session rows remain available independently. Repeated calls still perform their authoritative list reads. Focused regressions cover seven overlapping list requests, bounded reads of 64 cold histories, retry and lifecycle cancellation, subagent navigation, workspace stream races, and rejected model selection. Synthetic history counts are not a claim of live provider throughput or capacity for 50 simultaneous model executions.

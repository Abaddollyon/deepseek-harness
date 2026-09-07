# Agent Note: Recover Session feed readiness without losing navigation

Status: implemented

English | [中文](2026-09-07-session-feed-readiness-recovery.zh.md)

## Problem

A reachable Host can expose its Remote gateway before the Session controller's injected services become available. The first control request then terminates with `gateway/service-unavailable`. A connected transport and empty Client arrays cannot establish that the account has no saved Sessions. Pending list notifications can also mask a restored selection before its first authoritative list arrives.

## Decision

The [Session Client](../../../../packages/api/session-controller/README.md) owns bounded recovery of its control stream and list readiness. It retries only the Gateway's existing typed service-unavailable response. An accepted control baseline triggers an authoritative list pull; both must succeed before the observable feed reports ready. Terminal failures remain observable, and manual retry starts a new configured budget. The feed retains Session objects and selection during failures; pending initial lists leave persisted selection intact.

Each replacement fences older callbacks and waits for the preceding control iterator to close. Disposal cancels the retry timer and prevents later callbacks or explicit retry from reopening the feed. Carrier loss keeps the Gateway's existing physical-generation recovery, with stale data visible until the replacement baseline and list succeed.

## Alternatives considered

**Reload after failure.** Reload restores the data but discards the user's local interaction context and requires them to recognize a falsely empty screen.

**Retry every Remote failure.** Authentication, business rejection, and malformed protocols require attention; repeating them hides the failure and adds requests without a readiness signal.

**Treat connectivity as readiness.** The reachable gateway and the dependency-gated Session service have different owners and settlement points, so one connectivity flag cannot represent both.

## Consequences

Readiness retry has a finite deployment-configured schedule and a visible terminal state. Consumers must use the feed's readiness alongside retained rows when distinguishing loading, stale, failed, and successfully empty views. Loader composition and focused lifecycle tests cover delayed service availability, list ordering, exhausted retries, manual retry, protocol failure, carrier recovery, retained selection, and disposal.

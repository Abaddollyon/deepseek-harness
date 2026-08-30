# Agent Note: Bounded JSONL session listing

Status: implemented

English | [中文](2026-08-25-session-list-load-performance.zh.md)

## Problem

JSONL session listing performed independent project and session directory reads sequentially, so large roots waited on each header probe in order.

## Decision


Default `listConcurrency` is 32. `JsonlSessionPersistence` runs both cold root-encoding validation and `listArtifacts` directory/header probes through the validated bound while preserving discovery order, duplicate-id rejection, cancellation, and earliest discovery-order error semantics. Cancellation stops workers from claiming more probes; ordinary failures still settle the bounded traversal before the earliest ordered error surfaces.

## Alternatives considered

**Use unbounded Promise fan-out.** Rejected because deployment roots can contain many sessions and unbounded filesystem pressure is unsafe.

**Return completion order.** Rejected because callers depend on deterministic discovery order and earliest ordered errors.

## Verification

`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` covers 158 JSONL tests, including distinct concurrent failures, a cold existing-root cancellation that proves the public `listConcurrency` cap stops further probes, a successful retry after that aborted validation attempt, complete results, and persistence API forwarding.

## Consequences

Deployments can tune filesystem pressure with listConcurrency while callers receive deterministic complete results.

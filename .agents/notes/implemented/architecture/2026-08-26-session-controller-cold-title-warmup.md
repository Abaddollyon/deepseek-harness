# Agent Note: Session-controller cold title warmup

Status: implemented

English | [中文](2026-08-26-session-controller-cold-title-warmup.zh.md)

## Problem

Listing persisted sessions waited for cold work and had no durable title path for rows without an attached Session.

## Decision

ApiSessionList keeps a cache bounded to currently visible cold rows and keyed by createdAt and cwd. A list returns immediately and starts nonblocking batched sessionQuery.readTitleSnapshots work. Fulfilled snapshots are used by a later poll; failed or aborted batches remain retryable, while batch-entry identity checks, live-session checks, and teardown disposal prevent stale results from publishing. A live row invalidates its cold title, so a later cold listing refreshes durable title data.

## Consequences

Cold listing stays metadata-only and title reads are batched, while title visibility is eventually consistent across polls. Cache pruning prevents disappeared records from retaining title state.

## Alternatives considered

Opening a full Agent or waiting for title reads would violate cold-list latency and activation guarantees.

## Supersession

A search of active implemented notes found no earlier note covering this mechanism. The inspected fork commit 834a5d79dd549d8b3b55d1286c3f2b3e7b663cb8 was intent evidence only; this note records the current session-controller implementation.

## Verification

Focused cold-session tests, exact changed-source coverage, package typecheck/build, lint, and documentation gates are required before release.

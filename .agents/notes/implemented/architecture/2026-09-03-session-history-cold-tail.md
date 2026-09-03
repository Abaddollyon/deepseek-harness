# Agent Note: Detached history cold-path tail decoding

Status: implemented

English | [中文](2026-09-03-session-history-cold-tail.zh.md)

## Problem

Detached follow previously restored every event before its opening snapshot, blocking on zstd decode and projection refolding.

## Decision

Detached follow consults the identity-bound cache checkpoint and decodes only reverse zstd tail frames covering the requested watermark. historyTail is opt-in; plain JSONL, seeded lineage, absent cache, and backends without a frame index use the established full-read fallback. SESSION_FORMAT_VERSION and wire contracts are unchanged.

## Consequences

Cold first-frame work scales with the tail, while stale or missing checkpoints remain safe. The normal scanner and coordinator validation remain authoritative.

## Alternatives considered

A sidecar index would add a persisted format and migration burden; reverse scanning existing complete frames avoids that change. Full restore remains the compatibility fallback.

## Testing

The opt-in benchmark creates 3,000 events across 30 frames (more than 30 MB logical JSON), compares the first tail page with the full-restore oracle, and bounds event-loop delay.
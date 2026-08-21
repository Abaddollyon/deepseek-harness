# Agent Note: A keyed session index and seek-capable tail reads

Status: implemented

English | [中文](2026-08-20-persistence-keyed-index-and-paged-tails.zh.md)

## Problem

Two reads dominated cold load, and both were O(corpus).

`list()` on the JSONL backend opened every artifact to recover its header. A corpus of a thousand sessions meant a thousand file opens — and with zstd compression, a thousand frame decodes — before the GUI could draw its session list. The measured deployment carried 1,036 logs over 551 MiB.

`history` had no way to ask for a bounded tail. Every backend answered by materializing the complete stored log and the caller sliced it, so opening one conversation with a 500-turn history read and decoded every event of that session to display the last page.

## Decision

**A durable keyed index beside the artifacts.** The JSONL backend writes `session-index.json` (`JSONL_INDEX_FORMAT_VERSION = 1`) holding one `SessionIndexEntry` per artifact. `list()` reads the index and returns headers without opening a single log. Freshness is per artifact (`indexFreshness(identity)` over a `FileRevisionIdentity`, compared by `sameFreshness`), so a stale or missing entry repairs just that artifact: `repairIndexedArtifacts` re-reads what changed, `discoverUnindexedArtifacts` folds in what appeared, and `rebuildIndex` is the cold path when no index exists. Index writes are serialized through `withIndexLock`.

**A seek hook on the persistence seam.** `SessionPersistence.loadStoredTail?(id, beforeSeq, limit, signal)` is optional: a seek-capable backend implements it, a sequential one omits it. The coordinator's public `readTail(id, beforeSeq, limit, signal)` validates its bounds (`beforeSeq` a non-negative safe integer or `undefined`; `limit` a positive safe integer), waits on the same write-behind barrier as every other read, serializes per session, and either calls the hook or slices a complete prefix. It returns `StoredTail` — a seq-ascending page plus whether older valid events precede it — with detached metadata, so a caller can page backwards without holding the log.

**SQLite reads the tail from the store.** `SCHEMA_VERSION` moves to 18 with a physical chunk-row codec, and `readTail` walks stored rows backwards from the bound instead of rebuilding the logical log.

**Frozen-event retention, async zstd, and a header cache** ride the same change: the index caches what the header read used to recompute, decoding moves off the synchronous path (`decodeCompleteZstdFrame`), and retention keeps the frozen prefix a tail read depends on.

## Alternatives considered

**Trust the index and repair only on an explicit command.** Rejected: a durable index that can silently disagree with the artifacts is worse than no index, because every consumer above it inherits the lie. Per-artifact freshness makes the disagreement cheap to detect and local to repair, which is what allows the index to be trusted at all.

**Make `loadStoredTail` required on the seam.** Rejected: a sequential backend cannot implement it without materializing the log, which is the cost being avoided. Optional-with-fallback keeps the seam honest — the coordinator's contract is the same for both, only the cost differs — and the package rules require designing the Service Definition for all current Consumers, not the fastest.

**Let callers slice the tail themselves from `load()`.** Rejected: that is the status quo, and it puts the paging bound in every caller while leaving the read unbounded.

## Consequences

An indexed `list()` performs zero header reads; the measured case went from a thousand artifact opens to one index read. `SESSION_FORMAT_VERSION` is untouched — the index is derived data beside the logs, not a log format change — while the SQLite store takes a monotonic `SCHEMA_VERSION` bump to 18, which the repo's pre-release stance allows to reject older on-disk state outright. A backend without the seek hook keeps working at its old cost, so composition choices stay free. The index is a new durable file that a deployment's backup and cleanup procedures must know about.

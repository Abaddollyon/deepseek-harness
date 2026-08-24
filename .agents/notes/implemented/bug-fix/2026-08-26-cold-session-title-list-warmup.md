# Agent Note: Asynchronous cold-session title warmup

Status: implemented

English | [中文](2026-08-26-cold-session-title-list-warmup.zh.md)

## Problem

The Web session list obtained durable title values from the projection cache. A cold session whose cache row was absent therefore reached the client without its logged title, even though the title existed in the persisted session log. The client then used the workspace directory basename, producing the same label for many sessions in one workspace. The existing session-query title reader was available, but synchronously using it for every list row would turn an aggregate poll into a corpus scan.

## Decision

createApiProxy keeps a process-local cache of title observations keyed by session id and the durable header identity (createdAt and cwd). When a cold list row has no cached title projection, session.list returns immediately with the known metadata and queues that row for one asynchronous batched sessionQuery.readTitleSnapshots call. The response never awaits the read. The next list poll merges a settled title into the projection block; rows without a title or rows whose read fails remain unchanged. A cache hit in the projection cache continues to win, and a changed header invalidates the process-local observation.

All candidates from one list call are submitted as one batch, so a corpus of roughly 1,553 cold rows causes at most one title-observation operation for that listing, with the session-query service's configured persisted-inspection concurrency (four by default) controlling log reads. Later polls do not reread settled rows. The existing bounded cold-blank probe remains the only synchronous cold-log work in session.list.

This partially supersedes the statement in [resume selector batch projection](2026-07-31-resume-selector-batch-projection.md) that cold session titles remain metadata-only until resume. Its projection-cache and bounded-read decisions remain current; only the Web list's title availability changes.

## Alternatives considered

**Read every cold log synchronously in session.list.** Rejected because aggregate polling would wait on decompression and inspection for the whole corpus, violating list responsiveness.

**Add a second durable title index.** Rejected because title events already have an owned batched reader in session-query, while a second index would introduce invalidation, crash recovery, and migration obligations.

**Make the projection cache synchronously backfill every missing row.** Rejected because cache persistence is an asynchronous optimization and the list response must not depend on cache write completion; the process-local warmup also avoids rewriting cache ownership for a read-only list path.

**Keep returning the basename fallback.** Rejected because it hides the existence of durable titles and creates misleading collisions; the client-side dated untitled label is only an honest fallback, not title recovery.

## Consequences

The first list response after a cache miss remains fast and may omit the title; a subsequent poll receives the durable title without attaching or resuming the session. The warmup retains only one small header-keyed record per encountered cold row and isolates read failures from the list response. A process restart loses the warmup map and repeats one batched observation for cold rows until the projection cache is populated by normal session activity. Session format, projection schemas, and client identity behavior are unchanged.

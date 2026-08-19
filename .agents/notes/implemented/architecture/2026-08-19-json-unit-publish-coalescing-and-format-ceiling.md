# Agent Note: JSON units coalesce publishes and price legibility per unit

Status: implemented

English | [中文](2026-08-19-json-unit-publish-coalescing-and-format-ceiling.zh.md)

## Problem

The json backend republishes a unit's whole file on every write primitive, always pretty-printed, and `dsh-storage-json` sized that trade for the settings-shaped units it was designed around. The session projection cache broke the assumption: `session_projcache.json` holds one row per session, so it grows with a user's entire session history, and its plugin writes a checkpoint per throttle trigger (`writeEveryEvents`/`writeIntervalMs`) plus two mandatory points. On this workstation the live file is 2.59 MB over 723 rows, and one checkpoint cost about 19 ms of serialize plus temp-write, fsync, and rename — a per-write cost that scales with everything the user has ever done rather than with the session being written. Two separate multipliers were at work: `JSON.stringify(document, null, 2)` on a file no human reads, and one physical publish per commit even when several commits are outstanding at once.

## Decision

**Legibility is priced per unit, not per backend.** `serialize` takes a `FormatPolicy` and publishes pretty-printed while the compact document fits `Config.prettyPrintMaxBytes` (validated `z.natural()`, default 65_536 bytes), compact above it. The default sits two orders of magnitude above the units a maintainer opens (`workspace.json`, ~5.9 KB) and two below the machine-written caches (`session_projcache.json`, megabytes). `parse` is unchanged and reads either form, so the ceiling can move with no migration: the next publish rewrites the file in the new form. An assembly that wants the old behavior sets a ceiling above its largest unit; `0` publishes everything compact.

**Publishes are coalesced, never reordered.** `JsonKvUnit` keeps one publisher loop instead of starting a write per commit. Each mutating call applies its mutation to the authoritative in-memory state, registers an undo callback and a waiter, and marks the unit dirty; the loop takes every waiter registered so far, serializes the current state once, writes it atomically, and settles that whole batch. Commits that land while a write is in flight are settled by the next iteration, so N overlapping commits cost two whole-file writes instead of N. The backend contract is untouched: ordering still belongs to the caller, and an awaited call still resolves only after a durable file that includes the state it requested, because the batch it belongs to is taken before that publish serializes. A serialization identical to the bytes this unit published last is skipped — the medium already holds that exact file.

**Failure still leaves memory equal to the medium.** Rollback moved from each write primitive into the publisher: a failed publish undoes every mutation applied since the last durable file, newest first — the failing batch and anything queued behind it — and rejects all their callers. Nothing rejected can ride along with a later publish. `writeAtomic` is unchanged, so temp-write + fsync + rename + directory fsync still defines durability, and `close()` drains the publisher before releasing the unit.

## Measurements

One process ran the previous and current `openJsonUnit` against separate copies of the live `session_projcache.json` (723 rows, 2,585,922 bytes pretty), timing `putRecord` on it directly:

| | before | after (default ceiling) |
| --- | --- | --- |
| published bytes | 2,585,922 | 1,200,468 (-53.6%) |
| sequential checkpoint write, mean of 10 | 19.64 ms | 9.00 ms |
| republish of identical content | 19.03 ms | 4.28 ms, no write |
| 10 concurrent commits | 158.42 ms, 10 writes | 7.58 ms, 1 write |

Every variant reopened its published file and read all 733 rows back. The ceiling check costs one compact serialization, so a unit that stays pretty-printed is serialized twice per publish; at the default that is bounded by 64 KiB, and forcing the 2.59 MB unit pretty still measures 19.28 ms per write against 19.64 ms before.

## Testing

`packages/storage/storage-json/tests/publish.spec.ts` counts physical publishes by wrapping `rename`: a burst issued without an intervening await publishes once, commits made during a publish add exactly one follow-up publish, each awaited write finds its own record in the file it resolves on, an identical republish writes nothing, a burst leaves no temp-file residue and reopens intact, and a failed publish rolls back the commits queued behind it. The same file pins both formatting modes: compact past the ceiling, pretty below it, identical states out of `parse` either way. `tests/json-backend.spec.ts` keeps the shared `runKvBackendContract` suite and adds the `prettyPrintMaxBytes` validation and default.

## Alternatives considered

**Drop pretty-printing outright.** One line, and it deletes the property the backend exists for: `workspace.json` and the settings-shaped units are opened and read by maintainers. The cost is paid per unit, so the decision belongs per unit.

**A `format: 'pretty' | 'compact'` switch.** A per-root mode cannot separate the two units that share the shipped root, and pushing it per unit would mean a descriptor field every domain owner has to decide. The size of the document is the fact the choice actually depends on.

**A debounce window before publishing.** A timer would coalesce commits that a single-flight publisher cannot, but every caller awaits durability, so the window is added latency on every write; under the domain layer's write chain — which awaits each publish before issuing the next — it would coalesce nothing and slow every checkpoint. Rejected with the tunable it would have required.

**Resolving a commit before its bytes are durable.** The cheapest way to collapse the projection cache's serialized checkpoints, and it breaks the backend contract's durability clause for every consumer to help one.

**Per-record or append-based files.** The [domain KV storage Agent Note](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) already rejected append plus compaction for this backend; whole-file republish is what keeps the file the current net state. That note's format clause names `JSON.stringify(…, null, 2)`, which this decision narrows to units under the ceiling.

## Consequences

A projection-cache checkpoint costs about 42% less time and 53.6% fewer bytes, and a burst of overlapping cache writes costs one file instead of one per session. The saving still scales with total session count, because the file is still republished whole — the storage-domain routing decides which units belong on SQLite instead, and this change does not make the json backend a scale answer.

`session_projcache.json` is now a single compact line. Anyone who was reading it with an editor reads it through a formatter, or raises the ceiling for that root.

Coalescing helps only genuinely overlapping commits. The domain write chain awaits each publish before issuing the next, so a consumer that writes exclusively through `ctx.storageDomain` still gets one publish per write; its saving comes from the formatting ceiling and the identical-bytes skip. The README records this.

# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

JSON backend for the [storage hub](../storage/README.md): one `<unit>.json` file per unit under a configured root, registered as backend `json`. Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Model

- The in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state; scale is the SQLite backend's job.
- Legibility is this backend's reason to exist, and it is priced per unit: a unit whose compact document fits `prettyPrintMaxBytes` is pretty-printed, a larger one is published compact. Pretty printing costs roughly 50% more bytes on every whole-file publish — worth paying for the few-kilobyte `workspace.json` a maintainer opens, not for a megabyte-scale machine-written cache like `session_projcache.json`, which no one reads and which grows with total session count. Both forms parse identically, so moving the ceiling needs no migration; the next publish rewrites the file in the new form.
- Publishes are coalesced, never reordered. Commits that arrive while a publish is in flight wait for one follow-up publish of the final state, so a burst of overlapping commits costs two whole-file writes instead of one per commit; a publish whose bytes match the file this unit published last is skipped. An awaited write still resolves only after a durable file that contains it.
- A failed publish leaves nothing uncommitted: memory returns to the last durable file and every waiting caller rejects, including commits queued behind the failure.
- A missing file opens as an empty unit and materializes on the first write. A foreign or unparsable file rejects with `malformed-medium`; a stored version differing from the descriptor rejects with `version-mismatch` (no migration, pre-release stance).
- Write ordering across calls belongs to the caller (the domain layer's write chain); each single call is atomic and durable once resolved.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; created `0o700` on demand |
| `prettyPrintMaxBytes` | non-negative integer | `65536` | Largest compact document, in UTF-8 bytes, still published pretty-printed; a larger unit publishes compact. `0` publishes every unit compact |

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Coalescing bounds bursts of **overlapping** commits only. The domain write chain awaits each publish before issuing the next, so a consumer writing through `ctx.storageDomain` alone still gets one publish per write; there the saving comes from the formatting ceiling and the identical-bytes skip.
- The pretty-print decision serializes the compact document to measure it, so a unit under the ceiling is serialized twice per publish (bounded by the ceiling, sub-millisecond at the default).
- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer; the multi-process story is deferred per the Agent Note's out-of-scope table.

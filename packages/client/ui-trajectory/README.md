# @deepseek-ai/dsh-client-ui-trajectory

English | [中文](README.zh.md)

Trajectory renders a turn-aware event ledger with selectable User, Assistant, Tool, and nested Subtool records. Thick rules mark Turn boundaries, compact inline markers identify Steps, and the main ledger keeps only index, event, and content; selection opens a local inspector for token usage, duration, Input, Output, and Timing. Scrollable Summary regions keep their scrollbar thumbs transparent until the region is hovered or contains keyboard focus, without changing the reserved scroll geometry. A standalone compaction request appears chronologically in its own `Between turns` section, while a numbered compaction remains inside its owning turn. Long ledgers open at the current tail, load one older page when the user reaches the loaded range's top, and mount only the visible row window plus a small overscan; request-only separators share the next measurable virtual item, while semantic row keys and ARIA indexes survive prepends. Selection, timeline navigation, folding, search, and Request totals cover the currently loaded window. The ledger covers records with an explicit loading row until the initial tail is positioned. While an older prefix remains unloaded, a first-row control precedes the loaded records, loads one earlier page on click, and changes in place to a disabled loading status while that page is pending. A fixed Overview above the ledger projects real record start/duration timing from left to right; when earlier records remain unloaded and the viewport includes the loaded domain's start, a neutral ellipsis control identifies the omitted prefix and loads one earlier page without assigning unknown history fabricated duration. Assistant spans divide recorded TTFT from decoding, and a 500 ms hover reveals exact clock and duration details. Dragging an interval focuses the ledger on every record active at any point in that inclusive range, while clearing the selection restores the full loaded ledger. Wheel gestures zoom the time domain. A right-button click cl... (line truncated to 2000 chars)

## Model Experience

None, as the trajectory views render session data in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Derivation cost

Streaming publishes a new view snapshot per chunk, so both derivations reuse identity rather than rebuilding the session. `TrajectorySnapshotBuilder` folds each freshly built snapshot onto the previously published one: a section whose content did not move keeps its array, map, and member identities, and a flush that moved nothing republishes the same snapshot object. A chunk that only advances the in-flight assistant therefore leaves `eventNodes`, `eventLocations`, `requests`, `callSchemas`, and `runningCalls` unchanged, and every memo below them holds.

`deriveTrajectoryLayout` takes an optional per-view cache from `createTrajectoryLayoutCache()`. With one, a record whose node, tool result, call start, preceding wall time, and tool schema are all unchanged keeps its previously expanded cells; a turn whose groups hold the same cells keeps its model; and a derivation that moved nothing republishes the same turn array. Node-derived indexes extend in place when the new `nodes` array only appended members, and rebuild whenever it did not (loading an earlier page). Without a cache the function expands every record again; the two paths produce equal content and differ only in identity, which is what `tests/layout.client.spec.tsx` asserts at every point of an append sequence.

The timeline model is derived once per frame by `TrajectoryView` and passed to both the overview and `trajectoryTimelineFocusIndexes`. Live search keeps the finalized match set in its own memo so a streaming token rescans only the in-flight tail.

## Known Limitations and Deferred Work

- **In-flight Time stays blank** — `partial` and `runningCalls` rows show their running state without a fabricated duration, so the Overview renders a start marker rather than inventing a live span. Record and timeline selection are local to Trajectory, with no anchor deep links.
- **Client plugins carry no cordis.yml config** — the browser boot graph (`window.__DSH_BOOT__`) passes `id`/`url`/`rev`/`inject`/`immediately` only, and the shell creates each entry with `loader.create({ name })`, so a browser-half `Config` export would never be read. The virtualization threshold, overscan, and search-index throttle stay module constants until `dsh-client-modules` carries entry config onto the wire.

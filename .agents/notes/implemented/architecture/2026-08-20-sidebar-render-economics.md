# Agent Note: Sidebar render economics under a thousand rows

Status: implemented

English | [中文](2026-08-20-sidebar-render-economics.zh.md)

## Problem

The sidebar re-rendered itself for almost anything.

Its row components subscribed to the whole session list state, so any change anywhere re-rendered every row. Drag hover was carried in shared drag state, so moving the pointer across a list changed props on every row rather than on the two rows involved. Group derivation had no cache and re-ran on every render. And the pointer-move handler measured the column with `getBoundingClientRect()` on every single move event — a forced synchronous layout per mouse sample, during a drag.

## Decision

**Narrow the subscriptions.** Workspace consumers read ids, byId, current, and phase as separate narrow selectors over a memoized catalog object, rather than one whole-state subscription.

**Memoize the rows.** `ProjectRowItem`, `SearchResultItem`, and `SessionNodeItem` are `React.memo` with explicit comparators. The session comparator deliberately treats times as equal while they render as the same relative unit and count, so a clock tick that changes nothing visible changes nothing rendered.

**Confine drag hover to the rows that own it.** `RowDragProps` exposes `hover(half)`/`clear`, and `SessionNodeItem` owns its own drag marker; parents hold refs and memoized maps, and workspace hover uses an imperative class marker. A pointer crossing the list now re-renders the row it left and the row it entered.

**Cache the geometry, refresh it on the edges that move it.** The column rect is held in a ref and refreshed on mount, resize, `ResizeObserver`, pointerdown, and pointerenter; `pointermove` reads the cache. The code is explicit that the test is against the column **box, not DOM containment**, which is what makes a cached rect sufficient.

**Reuse the derived tree.** `deriveGroups` takes a narrow `Pick` of the catalog and keeps a one-entry identity cache, so identical narrow inputs return the same derivation.

## Alternatives considered

**Virtualize the sidebar list.** Rejected for this change: the measured cost was per-render fan-out, not per-row mount, and memoized rows with narrow selectors remove it without taking on windowing's scroll-restoration and measurement obligations. Virtualization stays available if row *count* rather than update *frequency* becomes the ceiling.

**Recompute the rect on a rAF during drag instead of caching it.** Rejected: it trades a forced layout per move for a forced layout per frame while still being wrong across a resize that the observer already reports exactly.

**A general memo cache for `deriveGroups`.** Rejected: the access pattern is one live catalog, so a one-entry identity cache captures every hit an LRU would, with no eviction policy to get wrong.

## Consequences

Hover and selection now cost two row renders instead of a list. The cached rect is stale between its refresh edges by construction — acceptable because those edges are exactly the events that move the column, and `ResizeObserver` is treated as optional so the component still works without it. The tree cache is a module-level one-entry cache, so it is shared per module instance rather than per component, and its correctness rests entirely on the narrow input identities the runtime now keeps stable.

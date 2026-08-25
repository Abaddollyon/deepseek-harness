# Agent Note: Contain offscreen chat rows

Status: implemented

English | [中文](2025-08-28-chat-row-content-visibility.zh.md)

## Problem

Paging a 500-turn conversation mounted roughly 105,000 DOM nodes and spent about 12 seconds in layout as older pages were appended. The chat renderer already isolates each stable node row, but the browser still laid out every offscreen markdown and tool subtree.

## Decision

Chat flow rows use CSS content-visibility: auto with contain-intrinsic-size: auto 240px. The browser keeps each stable row in the contiguous rendered order and preserves an intrinsic height estimate while skipping offscreen subtree style, layout, and paint work. The append path and Conversation Nodes remain unchanged: no event-window, Context, or Node scan was added.

## Alternatives considered

**Full JavaScript virtualization** was not selected for this change because it would require a scroll-height and measurement owner, explicit keyboard/find navigation for unmounted rows, and new prepend/tail anchoring logic.

**Removing markdown and tool details from old rows** was rejected because it changes inspection, accessibility, and find-in-page behavior.

**A larger intrinsic-size estimate** was rejected because it increases scroll-position correction when rows first become visible; the automatic remembered size keeps revisited rows stable.

## Consequences

Long conversations retain one contiguous DOM order, stable node identity, keyboard navigation, and browser find-in-page semantics because rows remain mounted. Offscreen subtree work is deferred until scrolling exposes it, while the browser may refine estimated heights as rows are visited. This reduces layout work but does not reduce total DOM node count; full virtualization remains a separate decision if retained heap or DOM cardinality becomes the dominant cost.

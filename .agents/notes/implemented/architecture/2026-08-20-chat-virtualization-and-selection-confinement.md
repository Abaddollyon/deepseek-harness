# Agent Note: A long conversation costs what is on screen

Status: implemented

English | [中文](2026-08-20-chat-virtualization-and-selection-confinement.zh.md)

## Problem

Three costs in the chat view scaled with the conversation rather than with the viewport.

`ChatView` mounted a seat for every node. A long trajectory with many subagents therefore held thousands of live React subtrees, and every update reconciled all of them.

Selection was read in `ChatView` and threaded into every seat as a prop, so selecting one tool call re-rendered the entire conversation to change the appearance of one row.

The details panel resolved a call by `findToolCall`, which recursively traversed every root and every subcall until it matched — an O(all calls) walk on a per-selection interaction.

## Decision

**Window the flow above a threshold.** `ChatView` virtualizes past 500 rows with 12 rows of overscan, a 160px estimate and a 16px gap, mounting the visible window plus overscan. Bottom-follow, prepend, and scroll restoration are preserved across the change: activation and restore are explicit steps, expansion pins the expanded row, and a semantic anchor is captured so a restore lands on the same conversation position rather than the same pixel offset. Hot scrolling resolves rows by binary search over measured offsets — the code carries the rationale for that choice at the search site.

**Confine selection to the two rows that own it.** Each memoized `ChatNodeSeat` runs its own selector, which returns a callId only for the root it indexes. A selection change re-renders the old owner and the new owner; everything else keeps its memo.

**Index the calls instead of walking them.** `MutableChatNodeStore` maintains a `toolCalls` map and a reverse `toolCallIdsByNodeKey` map, updated iteratively with a `Set` cycle guard as nodes change, and the details panel resolves through O(1) lookup helpers.

## Alternatives considered

**Cap the rendered history instead of windowing it.** Rejected: a cap deletes reachable content, and the conversation is the product. Windowing keeps every row addressable while paying for the visible ones.

**Restore scroll by pixel offset after a prepend.** Rejected: a prepend changes every offset above the viewport, so a pixel restore lands somewhere arbitrary. Capturing a semantic anchor and restoring to it is what makes prepend-during-scroll survivable, and a test asserts the anchor matches what the pre-virtualization scan produced.

**Keep selection in `ChatView` and memoize the seats on it.** Rejected: the prop still changes for every seat, so every memo comparator runs and every seat re-renders anyway. The selector has to live inside the seat for the fan-out to actually stop.

**Rebuild the call index on each snapshot.** Rejected: it converts a per-interaction walk into a per-update walk, which is worse for a streaming conversation.

## Consequences

The effective virtualization threshold is above 500 rows; a mount that restores a saved scroll position deliberately avoids virtualization so the restore is exact. Pinned and anchored rows may render outside the overscan window by design. Indexing moves one subtree traversal onto each changed tool root rather than onto each lookup, which is the trade that makes selection O(1). A store built without the optional indexing capability returns `undefined` from the lookup helpers, so consumers fall back rather than fail. The assembled browser output changes, which is why this landed with a web-replay snapshot refresh.

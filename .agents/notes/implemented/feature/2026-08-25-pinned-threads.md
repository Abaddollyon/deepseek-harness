# Agent Note: Pinned threads in the workspace sidebar

Status: implemented

English | [中文](2026-08-25-pinned-threads.zh.md)

## Problem

Codex/Claude Code-style pinned threads — pinning a Session to the top of the sidebar — shipped only as a Vesper compiled-bundle patch against `dsh-client-ui-workspace`, never as core source, so the feature silently disappeared when compiled runtime patching was retired for rc2. Its patch manifest specified the behavior: browser-local pins that survive reloads, render in their own section at the top of the sidebar in both the grouped and the flat view, with the normal session lists omitting pinned rows so each thread appears exactly once. Re-implementing it in core collides with an unrelated feature that already owns the word "pinned": the automatic live-row holdout a folded Workspace group renders under its header (`GroupNode.pinned`, the `pinned` prop on `SessionNodeItem`).

## Decision

**User pins are view-store state.** `createWorkspaceViewStore` gains `pinnedSessionIds: string[]` (explicit pin order) and a `togglePinnedSession` action; the persist key moves to `dsh.workspace.view.v6` because rehydration replaces the whole snapshot and a v5 blob would leave the new field undefined. Pins are browser-local and never reach the Host.

**The derivation owns the exactly-once rule.** `TreeView.pinnedSessionIds` threads pins into `deriveGroups`, which excludes pinned Sessions from every group and from the folded-group live holdout while keeping their order-accounting slots, so unpinning restores the accounted position. A new `derivePinnedSessions` projects the stored pin ids in pin order, skipping unknown, blank, archived, and subagent-origin ids in place without rewriting the stored list, so an archived pin revives on unarchive. `deriveFlat` deliberately keeps pinned Sessions: it feeds the flat order account, and dropping an id there would cost the thread its manual position — the flat renderer filters pinned rows only after the stored order is reconciled, and flat drag commits rewrite the full account order rather than the rendered rows. That is the failure the retired patch line's "flat-order repair overlay" existed to fix, now the design's first form rather than a follow-up correction.

**The renderer keeps the two "pinned" concepts visibly distinct.** The folded-group holdout keeps `GroupNode.pinned` and the `pinned` row prop (automatic, per-group, live-only); the user pin adds the distinct `userPinned` prop and `onTogglePinned` callback on `SessionNodeItem` (row menu **Pin session** / **Unpin session**), and a `PinnedSessionSection` at the top of both browsing modes. JSDoc on both sides names the other concept so a future reader cannot merge them.

## Alternatives considered

**Overload the existing `pinned` row prop and `GroupNode.pinned` field.** Rejected: the holdout is automatic, per-group, and live-only, while user pins are explicit, cross-group, and state-independent; one field for both would let a pinned live Session render twice (Pinned section plus folded holdout) and would invite exactly the confusion the naming rule exists to prevent.

**Keep the v5 persist key and tolerate a missing field at consumption.** Rejected: the store engine wholesale-replaces state on rehydrate, so every consumer would need an `Array.isArray` fallback for a field the type declares present; the pre-release stance favors a versioned key over a compatibility shim.

**Filter pinned ids inside `deriveFlat`.** Rejected — this was the retired patch's first form: the flat order account is derived from that row set, so pinned ids silently left the stored order and unpinning appended the thread at the end instead of restoring its position.

## Consequences

Pinning moves a thread's row between its group or flat list and the Pinned section with exactly one rendering at all times, including the folded-live and current-group-reveal overlaps; unpinning restores the previous position in both modes. The one-time cost of the persist-key bump is that browser-local view preferences (expansion, per-account orders) stored under v5 are reset. Pins naming archived or deleted Sessions are inert — hidden everywhere, retained in the stored list — and revive if the Session becomes visible again.

## Testing

`tree.client.spec.ts` pins the derivation rules (pin order, in-place skips, group and Ungrouped omission, the folded-live overlap, position restore). `rows.client.spec.tsx` covers the row menu's Pin/Unpin duality. `workspace-browser.client.spec.tsx` covers the menu gesture, exactly-once rendering, group and flat position restore across pin/unpin, a flat drag while a pinned id is present, the folded-live and current-group-reveal double-render traps, persistence across a remount, and the pinned-only empty state.

## Related

- [Workspace sidebar order and folding](2026-08-11-workspace-sidebar-order-and-folding.md) — owns the folded-group live holdout this feature must not be confused with.

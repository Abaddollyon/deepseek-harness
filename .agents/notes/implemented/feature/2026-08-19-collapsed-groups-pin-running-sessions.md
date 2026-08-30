# Agent Note: Collapsed Workspace Groups Pin Running Sessions

Status: implemented

English | [中文](2026-08-19-collapsed-groups-pin-running-sessions.zh.md)

## Problem

Workspace groups in the sidebar start closed and, once closed, rendered no Session rows at all. A Session that was still running therefore disappeared from the sidebar the moment its group was folded, and folding is the sidebar's normal resting state. The user lost both the progress signal and the route back into work the agent was actively doing, with no indication that anything was hidden. Bounding a group's height is a display concern; it must not decide which live work remains reachable.

## Decision

`GroupNode` carries a second row array, `pinned`, alongside `sessions`. `deriveGroups` builds the group's rows once and splits them by expansion: an expanded group puts every row in `sessions` and leaves `pinned` empty; a folded group leaves `sessions` empty and puts its live rows in `pinned`, keeping their group order. A row is live when it is running itself or when `runningSubagentCount` is above zero — the count of running descendants reached through uninterrupted subagent-origin lineage. The finished-but-unopened reminder (`completed`) is settled state and folds away with the idle rows.

The two arrays are mutually exclusive, so no Session ever renders twice, and the folded group keeps the existing "no rows in `sessions`" contract that the drag, reorder, and overflow paths read. Those paths were left untouched: pinned rows receive no drag wiring, so a reorder can never target one, and `COLLAPSED_SESSION_LIMIT` still slices and counts `sessions` alone, so the **Show more** control stays absent while folded and its remainder arithmetic stays true to the expanded list.

Derivation is a pure `useMemo` over the live `useSessions` snapshot, so the pinned set follows activity with no separate state to go stale: a Session that starts running appears under its folded header, and one that stops drops out on the same pass.

### Presentation

A folded group with live work must not read as an expanded one. The header keeps its closed folder glyph, its unrotated chevron, and `aria-expanded="false"` — the group is genuinely collapsed, and the pinned rows are sibling `treeitem` rows of the same flat tree rather than disclosed children, so the attribute stays accurate for assistive technology. Pinned rows take the tree's 22px indent step under their header. When a fold still hides Sessions below its pinned rows, the group prints their count from `sessionCount - pinned.length` through the `sessions.hiddenIdle` dictionary entries, so the visible rows are never mistaken for the whole group.

### No configuration knob

This is one correct behavior, not a deployment-varying policy, so it ships without a `Config` field. A browser-half `Config` would also be inert today: `WebBootEntry` carries only `id`, `url`, `rev`, `inject`, and `immediately`, and the web boot path creates entries with no config, so a client plugin cannot receive cordis.yml configuration at all.

## Alternatives considered

**Keep one `sessions` array and filter it in the renderer while folded.** The folded group would then report rows in the array that drag, reorder, and the overflow slice all read, so every one of those paths would need its own exclusion rule and each would be a separate place to get the count wrong.

**Render pinned rows identically to expanded rows.** A folded group whose Sessions all happen to be running would draw exactly like an expanded one, making the fold state unreadable and the header toggle unpredictable.

**Report `aria-expanded="true"` because rows are visible.** Assistive technology would announce a collapsed group as expanded and imply the remaining Sessions are present. The rows are siblings in a flat tree, not disclosed children, so the honest value is `false`.

**Pin rows with a pending user interaction as well.** Waiting for approval is a state the group header should aggregate rather than one that forces a row out of its fold; extending the live predicate to it belongs with that header indicator, which does not exist yet. It stays listed as a known limitation.

**Pin the finished-but-unopened reminder.** A completed Session is settled, so pinning it would accumulate rows in every folded group until each was opened, which is exactly the height problem folding exists to solve.

**Add a `pinRunningSessions` config field.** A deployment that hides running work has no owner and no evidence; the repository requires a current consumer for a public choice, and client plugins cannot be configured from cordis.yml today.

## Consequences

- Folding bounds a group's height without deciding what stays reachable: live work survives every collapse, and settled work does not.
- `GroupNode` gains a required `pinned` field, so every construction site — including tests that build group literals — supplies it.
- Drag, reorder, and overflow logic are unchanged, because folded groups still expose no `sessions`.
- A folded group with live work occupies more vertical space than before, bounded by its own running Session count.
- Pending user interaction alone still does not survive a fold; the group-header aggregation that would own it remains unbuilt.

## Testing

`tree.client.spec.ts` covers pinned/`sessions` mutual exclusivity, own-activity and running-descendant pinning, exclusion of `completed` rows, and the running-to-idle and idle-to-running transitions across successive derivations. `rows.client.spec.tsx` covers the folded header reporting `aria-expanded="false"` with a closed folder and unrotated chevron while a pinned row renders, and that the pinned row is an indented, non-draggable `treeitem`. `workspace-browser.client.spec.tsx` covers the assembled group: live rows reachable while folded, the hidden-remainder count, the absent overflow control while folded, its unchanged remainder arithmetic once expanded, no duplicate row across the two arrays, and a pinned row leaving when its run ends.

## Related

Extends the sidebar's folding and order rules — the persisted zero-or-five open state and the transient **Show more** gesture — which this decision leaves intact. (This note was first implemented on the pre-upgrade line as commit `1611e4d1aa` and is re-landed here unchanged in behavior; the Agent Note it then cross-linked does not exist in this tree.)

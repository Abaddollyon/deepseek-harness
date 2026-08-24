# Agent Note: The Ungrouped Bucket Names Loose Chats

Status: implemented

English | [中文](2026-08-24-ungrouped-bucket-loose-chats.zh.md)

## Problem

Sessions attached to no workspace trail in a bucket the sidebar labeled only "Ungrouped" (未分组). The bare adjective named what the rows lack rather than what they are, and users read the bucket as an administrative leftover instead of the place their loose chats live. The wording had to say "chats" explicitly: these are conversations that simply have no workspace.

## Decision

The `group.ungrouped` dictionary entry now reads "Ungrouped chats" (en) and "未分组会话" (zh). The tree derivation's `UNGROUPED_LABEL` — the non-localized fallback consumed by search labels and cwd-less surfaces — is kept verbatim-equal to the en entry, and a tree spec asserts the two never drift apart. The workspace-deletion dialog's description (`delete.desc`) names the same label in both languages, and every end-to-end selector and replay snapshot that matched the old copy exactly now matches the new one.

## Alternatives considered

**Keep "Ungrouped".** It is the wording being reported as confusing; keeping it answers nothing.

**Rename to "No workspace".** It describes the absence, not the contents; a bucket of chats should say it holds chats. It also reads as an error state rather than a resting place.

**Label only the renderer and leave `UNGROUPED_LABEL` as "Ungrouped".** Search results and cwd-less fallbacks would then show a different name for the same bucket, re-creating the disagreement this change removes.

## Consequences

- The bucket reads as a collection of loose chats in both shipped languages, and the deletion dialog's "its sessions will appear under …" sentence stays true.
- `UNGROUPED_LABEL` and the dictionary are locked together by a test, so a future copy edit touches both or fails.
- English replay snapshots and e2e selectors moved with the copy; nothing keyed on the old label remains.

## Testing

`rows.client.spec.tsx` asserts the bucket renders the zh dictionary label and never the derivation's stored en label. `tree.client.spec.ts` asserts `UNGROUPED_LABEL === en['group.ungrouped']`. The assembled browser spec's ungrouped-bucket flow and deletion dialog assertions follow the new copy.

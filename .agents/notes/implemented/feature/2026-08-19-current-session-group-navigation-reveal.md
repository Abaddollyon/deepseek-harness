# Agent Note: The Current Session's Group Opens on Navigation

Status: implemented

English | [中文](2026-08-19-current-session-group-navigation-reveal.zh.md)

## Problem

Workspace groups in the sidebar start closed, and only two gestures ever opened one: the group header toggle and the group's ＋ button. Nothing opened the group holding the Session the user is actually in. Selecting a Session from anywhere but that header — startup selection, a fresh Workspace connect, a fork, a Host-side selection change — left its row inside a folded group, so the sidebar showed the user a closed folder and no route back to the conversation on screen. Collapsed groups pin running rows, but pinning covers live work only: an idle current Session in a folded group had no representation at all.

## Decision

Selecting a Session opens the group that renders its row, once, as the answer to a navigation event.

`WorkspaceBrowser` computes one `CurrentGroupReveal` from the current selection: `navigation` is the selected Session paired with the key of the group that renders it (`currentGroupKey` in `tree.ts` — the Workspace accounting for the Session, or the Ungrouped bucket), and `foldedKey` is that key, or null when the group is already open. `useCurrentGroupReveal` remembers the `navigation` value it last answered and expands only when that value changes. Both terms move only when the user or the Host navigates, so a fold changes neither: folding the current Session's group by hand is final until the selection moves again. This is the distinction the mechanism exists to make — auto-expansion is a response to navigation, not a continuous invariant that the current group must be open.

The reveal expands through `setGroupExpanded`, the same persisted `groupExpansion` record the header toggle and the group's ＋ write and the only account the tree derives `GroupNode.expanded` from. There is no render-time override, so the stored fold bit and the rendered `aria-expanded` cannot disagree, and a revealed group stays open across reloads exactly like a hand-opened one.

The reveal waits for the Workspace list baseline (`phase === 'ready'`). Workspace membership decides which group renders a Session; before the baseline lands every Session reads as Ungrouped, so acting early would open a bucket the arriving membership contradicts and leave that bucket open behind it.

### Why the browser owns it, not the tree

`SessionTree` unmounts whenever the region shows search results, the flat list, or the rail. A reveal record living there would be reconstructed on every remount, so returning from a search to the tree would re-open a group the user folded inside it. `WorkspaceBrowser` stays mounted across all three, so the answered navigation survives exactly as long as the fold decision it must respect.

## Alternatives considered

**Rely on the existing pinning mechanism instead.** Pinning keeps a folded group's live rows reachable, and a current Session that is running is already covered by it. It cannot serve navigation: the predicate is the Session's own run or a running subagent descendant, so an idle Session — the state of every Session the user is reading rather than driving — stays hidden. Widening the predicate to "live or current" would also print a pinned row under a folded header while the conversation for that row fills the main column, which reads as a group that failed to open.

**Treat "the current group is open" as a standing invariant.** A single `useEffect` that re-expands whenever the current group is folded is shorter, but the header toggle then does nothing on that group: the effect re-opens it on the same commit, and the user's gesture is visibly rejected. The navigation identity is what turns one correct expansion into a repeated one.

**Key the reveal on the group alone.** Dropping the Session from the identity would keep a hand-folded group folded, but selecting a different Session inside it would no longer open it, which is the primary defect this note fixes.

**Expand at each call site that navigates.** The group's ＋ already expands before starting a Session, so the pattern exists. Extending it to every route into a Session means the sidebar picker, the hero picker in another package, startup auto-selection, forks, and any future Host-driven selection each carrying the rule. The selection itself is the one fact all of them produce, so the reveal reads that instead.

**Override expansion in the renderer for the current group.** Rendering the current group open without writing the store keeps the user's stored preference untouched, at the cost of two accounts of one fold state: the header would report `aria-expanded="true"` while the persisted record says folded, and the next toggle would flip the invisible one.

**Add a config field for the behavior.** This is one correct behavior rather than a deployment-varying policy, and a browser-half `Config` is inert today: `WebBootEntry` carries no config, so a client plugin cannot be configured from cordis.yml.

## Consequences

- A Session is reachable in the sidebar from every route that selects it, including the blank Session a freshly connected Workspace creates.
- Groups still start closed, and a deliberate fold of the current Session's group survives re-renders, list updates, search, the flat list, and the rail.
- The reveal writes the persisted view store, so an automatic expansion outlives the page like a manual one; a user who wants the current group closed re-folds it once per navigation into it.
- Sidebar goldens that boot into a selected Session now show that group open with its rows, instead of a single folded header.
- `deriveGroups` and `currentGroupKey` share one resolution of the current Session's group, so the tint (`containsCurrent`) and the reveal cannot disagree about which group that is.

## Testing

`workspace-browser.client.spec.tsx` covers the reveal opening the current Session's group on mount with the persisted bit and `aria-expanded` agreeing; a deliberate fold surviving both a re-render and a fresh sessions snapshot for the same selection; a selection move inside the folded group opening it again; a selection hop inside an open group writing nothing; the loose-Session case opening the Ungrouped bucket; a freshly connected Workspace's blank Session; the deferred reveal while the Workspace baseline is pending and its completion once the baseline lands; and one folded group continuing to pin its live row and count its hidden idle row while another group is revealed. `rename-assembly.client.spec.tsx` reaches the current Session's row through the assembled browser with no expanding click.

## Related

Complements [Collapsed Workspace Groups Pin Running Sessions](2026-08-19-collapsed-groups-pin-running-sessions.md), which keeps live rows reachable through a fold and which this decision leaves intact, and extends the folding rules in [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md).

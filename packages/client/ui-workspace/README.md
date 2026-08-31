---
description: "Shared Workspace browser and picker plugin for the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

## Summary

Shared Workspace browser and picker plugin. `WorkspaceBrowser` fills the sidebar's `sidebar.workspaces` slot, while `WorkspacePicker` fills the page-local Session Intent hero's `conversation.hero.workspace` slot; both surfaces use the same Workspace menu and add flow.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="behavior"></a>
## Behavior

The browser renders grouped or flat Session rows from the global runtime hooks and owns Workspace add/rename/reorder plus Session reorder. A Workspace remembers whether it is closed or showing Sessions; an open Workspace shows five Sessions by default, offers a transient **Show more** control for the remainder, and returns to five after the whole Workspace is closed and reopened. Closing a Workspace never hides live work: every Session that is running itself, or that has a running descendant reached through uninterrupted subagent-origin lineage, stays as an indented row under the folded header, followed by a count of the Sessions the fold still hides. A finished-but-unopened Session is settled state and folds away with the idle rows. Those held live rows carry no drag wiring and are not part of the expanded list, so reordering never targets one and the **Show more** count keeps describing the expanded list alone. Creating a Session from a Workspace row first opens that group so the new row remains visible when the Session state arrives. Navigation opens the group holding the current Session for the same reason: a selection landing on a Session — including the blank Session a freshly connected Workspace creates — opens the group that renders its row once, so the row is reachable without a manual click. The reveal answers navigation alone, never a fold: folding the current Session's group stands until the selection moves again, and the reveal waits for the Workspace list baseline, which decides which group renders that Session. The folded holdout does not cover this case because it holds live rows only, and the reveal writes the same persisted expansion record the header reports through `aria-expanded`, so the stored fold state and the rendered one never diverge. Once the Workspace list baseline is ready, browser-persisted expansion and Session-order records retain only current Workspace ids plus Ungrouped and the flat-list account. View options combine grouping with ... (line truncated to 2000 chars)

A Session row's menu also offers **Pin session**: pinned threads render in a Pinned section at the top of the sidebar, in pin order, in both the grouped and the flat view. Pins are explicit user state, unrelated to the folded-group live holdout: the grouped and flat lists omit pinned rows so every thread renders exactly once, a pinned live Session never doubles as a folded group's holdout row, and the navigation reveal never duplicates a pinned current row. Pins live in the browser-local view store and are never sent to the Host, so they survive reloads. Pinning never costs a thread its place: the order accounts keep pinned ids, and the flat list filters pinned rows only after the stored order is reconciled, so unpinning restores the thread's previous group or flat position.

Collapsed search is one header action beside the view and add actions. In the rail, add and search render as 36px controls on the shell's shared horizontal entry path. Activating search expands the field across the header; an outside click collapses only a query that is empty after trimming — except while the rail search gesture is still in flight (until focus lands in the input after the column slide), so the expanding click cannot dismiss the search it opened — while the clear control always resets and collapses it. A non-blank search query replaces either browsing mode with one flat result list: case-insensitive title and Workspace substring matches appear immediately, while a 250 ms debounced Host request adds ranked current-conversation content matches and snippets. The English search input and its defensive request path remove NUL, cap the query at the wire schema's 500 UTF-16 code units without splitting a surrogate pair, and preserve the existing debounce and cancellation behavior. Each new query aborts the preceding request; a failed content search leaves metadata matches visible with a warning. The list is capped at 20, asks the user to narrow broader queries, and opens the selected Session without clearing the query or jumping to a specific event.

The picker lists real Host Workspace entities through the global `useWorkspaces` hook. Selecting a Workspace invokes the slot owner's `onPick` callback to retarget the frontend Session object. Distinct canonical paths remain separate id-keyed Workspaces when their basenames and display titles match; the sidebar hover detail shows a POSIX home or descendant as `~` / `~/…` and leaves a Windows path verbatim. Each registration declares a **directory-flow child hole** (`single` kind: `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`) that the composed picker package's client half fills with its picking interaction — the [`-native`](../../host/directory-picker-native/README.md) backend's renderless OS-chooser driver today, an in-app browsing dialog under a `-browse` composition. The flat **Add workspace...** action renders only while the surface's hole is occupied (occupancy read per menu render; an empty hole means the composition has no picking affordance — the seam's documented no-flow default, under which the sidebar header drops its add button rather than offering a dead one). This package owns the trigger and the adoption: the occupant reports one picked path per open through the hole's owner conversation (`open`/`busy`/`onPicked`/`onCancel`/`onError`), and the owner adopts it through the object layer, selecting the committed Workspace only after its list projection has refreshed; cancellation is silent, and errors land in the retryable folder dialog whose **Choose again** reopens the flow. Adding has exactly one route: the occupant's own create-folder affordance already covers a brand-new directory, so no separate create-by-name dialog exists. A menu only appears where there is something to choose between — with no Workspace listed, the anchor gesture raises the flow directly instead of a one-row popover, and it waits for the list baseline before treating an empty list as final. The runtime Session and Workspace services own material... (line truncated to 2000 chars)

Workspace and Session hover cards copy the value their row clips: activating a Workspace card writes its full directory path, while activating a non-blank Session card writes its full display title. A provisional blank New Session card remains read-only because its localized label is a placeholder rather than session content. The card reports the dictionary-driven copied state only after the browser accepts the clipboard write.

The Session row's Fork action forks at the source's last completed turn, increments the inherited persisted title on the client, and then opens the child; a trailing ASCII or fullwidth parenthesized number is incremented in the same style, while an unnumbered title gets ` (1)` appended. The source and child always appear as peer rows within a workspace group, with lineage retained only as session data. A fork or rename failure leaves the current selection unchanged; after a rename failure, the created child remains in the list.

Session rows render the runtime's live `pendingInteraction` classification: approvals report **Waiting for approval**, plan reviews report **Plan awaiting review**, and ordinary questions report **Waiting for answer**. Every pending interaction uses an amber warning dot that takes precedence over the running indicator; ordinary rows repeat the localized status in their hover card, and both ordinary and search-result rows carry the same text as a visually hidden label for assistive technology. Running uses the blue indicator and its hidden label; an idle row leaves the reserved status slot empty.

Both target slots are declared by other plugins, so `apply` uses `slots.inject()` to register for each declaration lifetime and re-register after a declaring slot is restored.

The shared sidebar projection hides rows whose durable Session summary has `origin: 'subagent'`; users enter those conversations through the selected parent's subagent header catalog. Each visible ordinary row inherits the blue activity indicator while any descendant reached through uninterrupted subagent-origin lineage is running, and its hover and assistive text report the exact running-descendant count without describing an idle parent as running. Ordinary forks remain visible and terminate this aggregation because lineage alone does not set their origin. Pending user interaction outranks the session's own running state, and either remains the primary row status while descendant activity stays available as a separate hover and assistive status. With neither present, descendant activity outranks the green unviewed-completion reminder; the reminder returns once no descendant is running. The runtime keeps hidden rows available for conversation, title, and addressed transport state.

<a id="model-experience"></a>
## Model Experience

None, as the picker is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No fuzzy content search or event deep links** — the content backend uses literal token/phrase matching, and selecting a result opens the Session rather than the matching event.
- **No Session deletion or unarchive control** — sessions can be archived, but archived sessions have no viewing or unarchive surface, and Workspace registration deletion does not delete Sessions.
- **Pending user interaction is not aggregated into collapsed groups** — a waiting row inside a collapsed group lights no group-header indicator, and a waiting Session that is neither running nor host to a running descendant becomes visible only after that group is expanded.
- **Native folder selection depends on the local Host carrier** — under the `-native` composition, in-process or remote browser deployments cannot open a local operating-system dialog; platform failures are shown in a retryable modal. Remote-capable picking is the `-browse` composition's in-app flow.

<a id="dev-note"></a>
### Dev Note

Workspace and Session projection changes require grouped, flat, search, pinning, and collapsed-state coverage.

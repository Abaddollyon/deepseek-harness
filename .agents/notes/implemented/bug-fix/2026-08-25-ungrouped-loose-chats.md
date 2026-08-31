# Agent Note: Re-land the Ungrouped bucket as a first-class home for loose chats

Status: implemented

English | [中文](2026-08-25-ungrouped-loose-chats.zh.md)

## Problem

The retired compiled-bundle patch `apply-rc6-ungrouped-sessions` made the sidebar's Ungrouped bucket a first-class home for loose chats. When compiled patching was retired in the 0.1.1-rc.2 upgrade the behavior was silently lost, and a first repair restored only the bucket label; that behavior remains current and unaffected here. Two defects remained in source:

1. **The bucket's ＋ was inert.** `WorkspaceBrowser`'s group `onCreate` callback did nothing when the group had no `workspaceId`, because the only start path was the workspace-scoped `ctx.workspaces.startSession`. The bucket already rendered as a first-class group (`tree.ts`); only the action was missing.
2. **A workspace-less session was unusable.** `ConversationRoot` computed `inert` as `sessionId === undefined || (hero && chipTitle === undefined)`. A real blank session no Workspace accounts for has no chip title, so a loose chat rendered the workspace chooser over a disabled composer — defeating the ＋ that had just created it.

## Decision

- **Seam for creation: a new `createLooseSession` callback on `WorkspaceBrowserInjected`** — the register-inject face every other browser action already travels (`startSession`, `forkSession`, `open`). The component receives it as a prop, exactly like the retired patch did; no reaching around the seam into the concrete runtime or the wire client.
- **The outward sessions face grew `create({workspaceId?})`.** `ISessions` is documented as exactly what feature packages may do to the sessions domain, so exposing creation there is the explicit widening act the interface header reserves. `SessionRuntime.create` already accepted an omitted `workspaceId` (only the type face hid it), and the wire fixture has always honored a workspace-less `session.create` — the Host assigns its default cwd. The cross-domain `SessionsPort` keeps its required `workspaceId`: `connectWorkspace`'s blank-reuse contract is workspace business and is untouched. The test double (`TestSessions`) implements the member, so the face change couples at compile time by design.
- **The ＋ expands the bucket before creating**, the same visibility contract the Workspace rows already honor (`setGroupExpanded` before `startSession`).
- **The inert predicate is `sessionId === undefined`.** Evidence: the retired patch's exact hunk (`const inert = sessionId === undefined; /* a session without a workspace is ready (host assigns default cwd) */`). No client-side state distinguishes a deliberate loose chat from a blank session whose Workspace was deleted — both are workspace-less, both keep a usable cwd, and the chip still offers moving the session into a Workspace until the first message. The no-session cold start keeps the workspace-trigger posture, so a true blank/hero state still prompts for a Workspace, and that posture still wins over a raised composer block (picking a workspace is the earlier prerequisite).

## Alternatives considered

**Put loose-session creation on `IWorkspaces` (e.g. a `startLooseSession` beside `startSession`).** Rejected: a session outside every Workspace is not Workspace domain behavior, and `startSession`'s omitted-argument semantics (inherit the current Session's Workspace, then the recent Workspace, else clear) deliberately resolve a target — the bucket's ＋ must unconditionally create outside them all.

**Keep `hero && chipTitle === undefined` for the deleted-Workspace case only.** Rejected: that state is indistinguishable from a loose chat in every observable the client has (no owning Workspace, ready list, cwd present or pending). Any predicate that prompts there also prompts for the loose chat the ＋ just birthed.

**Route the callback through `ctx.sessions.binding(id)` or the connection handle's `api.sessions.create`.** Rejected: both reach around the typed service face; the binding resolves existing sessions and the wire client belongs to the runtime.

## Consequences

- A blank session whose Workspace was deleted now presents a live composer instead of the workspace prompt; it can keep working as a loose chat or move into a Workspace through the chip. This is the intended first-class-loose-chat semantics, not a regression of the old revive-via-picker flow.
- A raised composer block still wins for a workspace-less session: the session exists, so the block's own reason owns the inert posture.
- The new loose chat interacts with the recently landed sidebar machinery without special cases: it lists under the bucket exactly once (user pins move it to the Pinned section; the folded live holdout never duplicates it), the navigation reveal opens the bucket for it, and the blank-promotion effect tops the Ungrouped order account through the generic current-blank path.
- `pnpm run test:coverage` consumers: `ISessions` widened, so any future face drift breaks `TestSessions` at compile time rather than silently.

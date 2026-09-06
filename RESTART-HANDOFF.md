# Vesper E1 Core Restart Handoff

Date: 2026-09-06
Branch: `codex/vesper-ui-redesign-core`
Worktree: `/tmp/vesper-ui-redesign-core`
Base pin: `e5cb51e52207ddc06b2e34281559370d7afc1bd1`

## Implemented

- Independent per-Host Cordis runtime roots, trusted manifest roster activation, injected request/stream carriers, generation fencing, registry leases, selected-runtime projection, and one persistent shell composition.
- Navigation-driven Host ownership, local overview control plane, committed `activeEnvironmentId`, connection/retry snapshots, and actual product-adapter assembly API.
- Atomic renderer presentation transitions that unmount React consumers before old runtime services/stores dispose, then publish the complete replacement graph.
- Compound Host/Session store identities while preserving native Session ids at Slot/API boundaries.
- Host-scoped selected Session, Conversation draft/view, Workspace view, and sidebar Activity state, including one-time migration from legacy unsuffixed local keys.
- Authoritative Session deletion clears persisted Session stores; Host handoff/reconnect releases live instances while retaining persisted drafts/views.
- Queue dock operations resolve the presentation-owned Conversation controller and pass the owning runtime Session face explicitly.
- Runtime generation gates composer mutation controls offline while leaving the unsent draft editable.
- Compact Activity/Environments navigation, responsive conversation containment, chat-only width handles, keyboard tabs, and compact header metadata wrapping.
- Cleanup paths attempt every disposer and preserve combined failures; activator withdraw/resume rolls back partial graph changes; navigation and hydration use last-intent fencing.

## Verification completed

- Actual assembled headless browser: local Chat/Swarm and remote Chat rendered correct sentinels in one shell; latest remote switch had zero accumulated page errors after queue fix.
- Actual disconnect/reconnect: one page, zero JS errors, remote draft retained and same Session/sentinel restored; truthful offline banner.
- Responsive assembled proof before the last header-only patch: no horizontal clipping/scroll at 320/360/736/1024 across four feature tabs; Activity overlay opaque/inert; native arrow/tab keyboard and Tasks Enter worked.
- Affected package run before the final bounded patches: 100 files, 1,194 tests passed with one worker.
- Review-blocker focused run after cleanup/hydration/migration changes: 5 files, 113 tests passed; cleanup idle regression 7/7; renderer/session persistence 68/68.
- Composer generation gate: 3 files, 85 tests passed and ui-conversation type build passed.
- Compact header/interaction focused run: 2 files, 27 tests passed.
- Focused type builds passed for environment-runtime, store, api-session-controller, ui-workspace, ui-renderer, ui-session, ui-conversation, ui-environment-navigation, and client-web.
- Fresh libs built for store, api-session-controller, environment-runtime, ui-renderer, ui-session, ui-conversation, ui-workspace, ui-environment-navigation, client-web. Last Vite app build before the final dynamic-package patches emitted `apps/web/dist/assets/index-CWngf6e4.js`; profiles use linked package libs for the later changes.

## Remaining browser acceptance gaps

1. Re-run offline composer after the last generation-gate build. Expected: `Send message` disabled while disconnected, contenteditable draft remains editable, enabled again after generation recovery.
2. Re-run 320/360 Agent Swarm header after the last CSS build. The source now stacks identity, actions, and utilities into wrapping rows under 640px; it has focused source tests but no assembled screenshot yet.
3. Remote New Session created a real blank row but landed on the no-workspace hero instead of Chat. Page errors were empty. Diagnose Session creation/navigation hydration versus blank-session initialized workspace state; the product adapter’s create contract may be involved.
4. After disconnect/reconnect, Chat restored but retained `Failed to load history: Environment stream disconnected (gateway/internal)` after connection returned. Re-subscribe/clear the history stream error on generation recovery.
5. Run the full affected package set once more after the final cleanup/migration/offline/header patches. The last full affected run predates those bounded changes, though all relevant focused tests and type builds passed.
6. Repeat final read-only staff review. The prior reviewer’s three remaining findings (cleanup restoration, fulfilled failed-refresh fence, legacy local persistence migration) were fixed after its final report and have focused regressions, but were not re-reviewed before reboot stop.

## Build/link notes

Profile links must resolve companion copies of at least: environment-runtime, ui-renderer, ui-session, ui-conversation, ui-workspace, ui-environment-navigation, api-session-controller, and store. The product adapter outside core registers the environment carrier factory and starts composition; this is intentional policy separation and actual browser proof exercised it.

No visible browser, Electron, server, push, deploy, or publication was launched by the core worker. The only browser command previously run was the authorized existing headless script `node /tmp/vesper-ui-redesign-evidence/exercise-native.cjs`; servers were parent-owned.

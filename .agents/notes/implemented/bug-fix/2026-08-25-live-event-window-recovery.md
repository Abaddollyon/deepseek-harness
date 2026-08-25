# Agent Note: Live events reopen an errored session window

Status: implemented

English | [中文](2026-08-25-live-event-window-recovery.zh.md)

## Problem

`Session.doOpen` settles into `openState: 'error'` whenever its history request fails — a transport fault, a timeout, or a host too busy to answer. `acceptLiveEvent` then discarded every subsequent frame, because a window that never installed has nothing to append to and history was expected to backfill on the next open. Nothing scheduled that next open. Only `resync()` rebuilds an errored window, and it runs on reconnect, so a session whose transport stayed up but whose single history request failed kept receiving live frames and dropping all of them. The user saw a conversation frozen at its last good state while the durable log advanced, and a browser reload was the only cure — which is exactly what made it look like a rendering problem rather than a lost window.

The failure needs load, not a bug elsewhere: a large session on a busy host makes the initial history request the slowest call in the open path, so it is the first thing to fail and the only one whose failure is permanent.

## Decision

A live frame arriving while the window is errored now reopens it instead of being discarded. Arrival is itself the evidence the retry needs: frames travel the mux stream, so one landing proves the transport recovered and the history request that failed can now succeed.

The frame is deliberately not buffered. The rebuild pulls the tail page, which already contains it, and buffering into a window that may never install is what would leak. `open()` is idempotent while a request is in flight, so a burst of frames raises at most one retry, and a retry that fails again leaves the state exactly as before — the next frame simply tries once more.

`'cold'` keeps its existing meaning and is untouched: a session that was never opened has no window to rebuild, and its history genuinely does backfill when something opens it.

## Alternatives considered

**Retry on a timer.** Rejected because it burns requests on a dead transport and still waits out its interval on a live one, while the frame that proves recovery is already in hand.

**Buffer the frames and stitch them on the eventual open.** Rejected because the retry pulls history anyway, so the buffer only duplicates what the page already carries, and an errored window that never reopens would grow it without bound.

**Surface a retry control instead.** Rejected as the primary fix: it makes a transient fault the user's problem. A visible error state remains worthwhile, but it belongs beside automatic recovery, not instead of it.

## Verification

`packages/client/runtime/tests/session.client.spec.ts` drives a failing history request, asserts the window settles into `'error'`, then delivers one live frame with the transport healthy and asserts the window reaches `'open'` with a second history call recorded. The case fails without the change: the window stays errored and no second request is made.

## Consequences

A session recovers from a transient history failure on its own, at the moment the transport proves itself, without a reload and without a reconnect. Sessions that legitimately cannot load — a deleted or unreadable log — still settle in `'error'`; each later frame costs one retry rather than silently doing nothing, which is bounded by the frame rate the host is already sustaining for that session.

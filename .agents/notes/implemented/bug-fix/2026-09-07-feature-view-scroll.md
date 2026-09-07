# Agent Note: Feature views own bounded scroll positions

Status: implemented

English | [中文](2026-09-07-feature-view-scroll.zh.md)

## Problem

The conversation's active view area can grow with transcript content. Applying that geometry to a feature with a percentage-height scroller lets the outer conversation scrollport retain a transcript offset while the feature expands beyond its viewport. A large member list can then hide its heading and selected detail.

## Decision

The [Conversation shell](../../../../packages/client/ui-conversation/README.md#shell-and-standard-props) marks non-Chat views and constrains their view area with a shrinkable flex allocation. The shared conversation scrollport clips in feature mode. Slot outlet wrappers retain the renderer's `display: contents`, so the view area and feature root participate directly in their enclosing flex layouts.

A feature identifies its primary scroller with `data-feature-scroll`; the view area is the fallback owner. Scroll positions belong to the native environment/session store identity and view id, with at most 32 view entries per store. Feature entry clears the shared shell offset and restores only the feature offset. Restoration waits for asynchronous child content when the saved offset is temporarily clipped. Explicit reader input ends that wait. Nested output scrollers and detached views cannot overwrite the primary offset.

## Alternatives considered

**Reset every view to the top.** This removes inherited offsets but loses a reader's position during feature tab round-trips.

**Share the transcript's scroll position.** Chat's anchors and bottom-follow policy describe transcript rows, not feature lists. Feature geometry cannot reuse those positions meaningfully.

**Remount the conversation root.** A remount couples scroll repair to composer and draft lifecycle. The resident shell and composer keep their existing identities.

## Consequences

Offsets survive view remounts while the native scoped store remains alive; they are not durable reload preferences. Chat retains its own anchor restoration and bottom-follow policy. The [sticky-composer decision](2026-07-29-sticky-composer-conversation-scroll.md) and [composer gutter decision](2026-08-04-composer-tab-gutter-reservation.md) remain applicable to Chat and composer positioning; feature clipping specializes the outer scrolling behavior without replacing those decisions.

Focused DOM tests cover feature and scope isolation, nested scrollers, detached events, and delayed content. Browser geometry checks remain necessary for long lists, responsive widths, composer placement, and tab round-trips because DOM fixtures do not perform layout.

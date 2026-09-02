# Agent Note: Sidebar session-row memoization

Status: implemented

English | [中文](2026-08-25-sidebar-row-memoization.zh.md)

> Scope: the workspace browser's top-level session rows in packages/client/ui-workspace/src/client/rows/Rows.tsx.

## Problem

The session list store republishes when its container state changes. The derived tree then creates fresh row objects even when a session's visible facts are unchanged, so rendering 1,001 sessions rebuilt the row subtree without producing DOM mutations.

A supersession search across active Agent Notes found no note covering this sidebar rendering mechanism. The runtime service's separate per-row identity reuse is a prerequisite, not a superseded decision.

## Decision

SessionNodeItem is a React memo with a scalar comparator. It keys equality on session id, title and untitled collision ordinal, blank state, pending interaction, running state, running descendant count, completion state, updated timestamp, current selection, flat/automatic-holdout/user-pin modes, locale translator identity, and the visible relative-time unit and magnitude. These fields cover every row-visible result of SessionNodeItemView.

Inactive drag command identities are ignored because they are id-keyed commands and unchanged row facts imply the same command target. Active drag objects remain identity-sensitive, so a rerender refreshes commit closures while a drag is in flight. Relative time compares by displayed bucket rather than raw clock milliseconds; a row repaints when its displayed label changes, not on every parent render.

## Consequences

Equivalent list republishes skip unchanged session-row subtrees while changed titles, running states, pending interactions, completion reminders, pin modes, group holdouts, selection, locale, collision labels, and time labels still repaint. Active drag operations retain current tree closures. The comparator is intentionally local to the presentation row and does not add a component subscription.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Default React memo equality | Derived row objects are rebuilt by tree derivation, so object identity is not stable enough. |
| Compare only session id | Running, title, pin, selection, group-holdout, and status updates could be dropped. |
| Compare raw time values | Clock milliseconds would defeat the optimization even when the displayed relative label is unchanged. |
| Ignore active drag identity | A dragged row could retain stale reorder commit closures after membership changes. |

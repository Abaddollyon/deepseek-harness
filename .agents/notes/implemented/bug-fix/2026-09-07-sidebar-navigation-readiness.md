# Agent Note: Sidebar navigation and readiness

Status: implemented

English | [中文](2026-09-07-sidebar-navigation-readiness.zh.md)

## Problem

A failed Session feed looked like an empty account. The sidebar could not return from Environments to its already-selected Session, and Activity showed workspace-only controls while ignoring workspace search and persisted pins.

## Decision

Explicit Workspace opens publish a shell navigation action even when the Session id is unchanged. Blank navigation has a Host-qualified `new-session` location and clears selection once per intent, allowing subsequent domain opens to leave the blank view. Creation failures remain visible and creation waits for feed readiness. Back navigation remembers the latest conversation independently of intermediate overview visits.

The sidebar distinguishes loading, error, stale rows, and successfully empty baselines. Workspaces and Activity have labeled controls; grouping, ordering, and adding workspaces belong only to Workspaces. Activity consumes one shared query and reads pins directly from the existing Host-qualified workspace view store. An unmounted Host's pins are read from that same persisted key. No second persisted pin set is introduced. Pin subscriptions are effect-owned; shell disposal releases retained presentation sources.

## Alternatives considered

**Inferring all navigation from changed Session ids** loses explicit same-session opens and cannot represent a blank conversation.

**A separate Activity pin store** duplicates persistent user intent and lets the two lists disagree. Reading the existing source preserves one owner.

**Treating an unavailable feed as an empty list** conceals recoverable service failures. Empty wording requires both Session and workspace readiness.

## Consequences

Navigation does not send messages or resume goals. Activity providers join pins with explicit Host identities and filter their own rows using the shared query. Component and service tests cover same-session reopening, blank navigation followed by a domain open, readiness failures, retained rows, creation errors, and independent Host pin sources. Native workspace content search is suspended while Activity owns the list.

# Agent Note: Replay reconciliation after alpha5 rebaseline

Status: implemented

English | [中文](2026-09-02-replay-reconciliation-after-alpha5-rebaseline.zh.md)

## Problem

Alpha5 replay exposed two regressions after the re-landed lanes: request preflight could consume the first scripted model response while asynchronously titling a session, and flow-row content-visibility auto corrupted geometry when a composed conversation ancestor owned scrolling.

## Decision

## Fix and intended recordings

The goal-tools and subagent-settlement replay overrides now put the title response before the main scripted response. This is an ordering contract under preflight admission, not a product behavior change. The ACP goal goldens and the ordinal-4 workflow/tool-schema snapshots were re-recorded for the intended b03 event-conditioned continuation and schema ownership changes.

ChatView keeps offscreen containment for its standalone scrollport, but scopes it away when data-conversation-scroll is an ancestor. A CSS contract test pins both sides of that boundary, preserving #33 performance without hiding ancestor-owned rows.

## Alternatives considered

Re-recording the product behavior was rejected: the response-order fix is fixture-only, while the ACP and schema golden changes are intentional b03 updates. Removing containment was rejected because standalone ChatView still benefits from #33.

## Consequences

Keyless replay again preserves tool calls and child settlement logs; web scroll geometry and hidden-until-found disclosure remain stable in both scroll ownership modes. The two snapshot scenarios ptc-python and session-sandbox-root remain pre-existing tag failures and are not re-recorded.

# Agent Note: Compact subagent catalog

Status: implemented

English | [中文](2026-09-06-compact-subagent-catalog.zh.md)

## Problem

Long-running conversations accumulate many inactive subagents. Two-line rows and creation order push running work below old history, while clicking a branch navigates away from the hierarchy users want to inspect.

## Decision

The [subagent catalog](../../../../packages/client/ui-subagent/README.md) places running agents and ancestors with running descendants before inactive siblings, retaining source order within each partition. Inactive rows show a single line of name, tokens, and active-turn duration; their full mode and activity remain in tooltips and accessible names. Inactive means not running, without claiming successful completion.

Clicking a branch or pressing Enter or Space expands or collapses its children through the existing lazy catalog observations. Arrow keys and the disclosure button retain their tree behavior. A separate Open button navigates to the branch conversation; leaves open directly. Layers preserve their real parent addresses and remain collapsed until requested.

## Alternatives considered

**Replace the catalog in a Vesper plugin.** This duplicates native navigation, lazy loading, and accessibility behavior. The native owner can provide the presentation without a second catalog implementation.

**Flatten every descendant immediately.** This loses workflow ancestry and requires fetching branches that the user has not opened. Compact sibling rows retain hierarchy without eagerly loading the full tree.

## Consequences

More historical agents fit in the scrollable menu and active branches remain easy to reach. Opening a branch conversation uses the explicit Open action. Component regressions cover ordering, compaction, and navigation; the persisted-subagent browser scenario checks branch expansion, one-line geometry, and the assembled accessible tree.

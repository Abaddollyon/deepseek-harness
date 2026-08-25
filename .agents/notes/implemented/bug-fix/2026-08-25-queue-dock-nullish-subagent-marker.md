# Agent Note: Queue dock reads an omitted subagent marker as an ordinary session

Status: implemented

English | [中文](2026-08-25-queue-dock-nullish-subagent-marker.zh.md)

## Problem

QueueDock gates its queued-row edit, remove, and steer controls on the conversation snapshot's addressed-subagent marker: an ordinary session keeps the controls, an addressed subagent loses them because its continuation transport exposes no queue mutation. A gate written as `s.subagent === null` reads a snapshot that omits the marker (`undefined`) as a subagent and hides the controls. During lint cleanup the tolerant pair `=== null || === undefined` then collided with `no-unnecessary-condition`: `ConversationSnapshot.subagent` is declared `{ address, parentAvailable } | null`, and its sole producer `Session.buildSnapshot()` always writes the field, so the `undefined` arm has no overlap with the declared type.

## Decision

The declared type stays authoritative: the field has been required `| null` since its introduction, `Session.buildSnapshot()` is the only snapshot producer, and no persistence or wire path rehydrates snapshots. QueueDock keeps the tolerant read in the idiomatic nullish form `s.subagent == null`, which covers `null` and an omitted marker without suppressing the rule, matching the `goal != null` precedent in InputBar. The regression test that fabricates an omitted-marker snapshot keeps pinning the tolerance: simplifying back to a strict `=== null` fails it.

## Alternatives considered

**Make `subagent` optional in `ConversationSnapshot`.** Rejected because no producer omits the field; declaring optionality would weaken the snapshot contract for every consumer to describe a state that never occurs.

**Delete the `undefined` arm and its regression test.** Rejected because the test pins deliberate tolerance; dropping both would let a future simplification to `=== null` reintroduce the hidden-controls failure with no signal.

**Disable `no-unnecessary-condition` at the site.** Rejected per the narrow-exception stance; `== null` expresses the same behavior without a suppression.

## Testing

`packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` drives a live snapshot whose `subagent` is `undefined` and confirms the edit affordance still opens; the addressed-subagent case keeps the controls hidden.

## Consequences

Lint stays clean with the behavior preserved, and the component comment records why the comparison is deliberately nullish. The tolerance costs one non-obvious idiom, and the fabricated fixture remains the only place an omitted marker exists — a reader tracing production producers finds the field always present.

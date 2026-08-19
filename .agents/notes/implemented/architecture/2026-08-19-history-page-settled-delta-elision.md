# Agent Note: History pages omit a settled step's superseded streaming deltas

Status: implemented

English | [中文](2026-08-19-history-page-settled-delta-elision.zh.md)

## Problem

Opening a chat sent the browser every raw event in the page range, including the per-token `assistant/chunk` deltas of steps that had already produced their terminal `assistant/message`. Those deltas restate nothing a reader cannot read from the message: the client folds them and then replaces the accumulated blocks wholesale the moment the message arrives.

Measured on the largest local session (629 k in-memory events), the default 50-message tail page carried 8,779 events and 3.02 MB of JSON, of which 8,326 events (94.8 %) were superseded deltas. `block-end` chunks duplicate the assembled block the message also carries, and `finish` chunks carry adapter `replayState` — including encrypted reasoning blobs — that no client reads at all. Assembling that page through the real Conversation Node pipeline cost 63.4 / 38.2 / 44.2 ms of blocking work before React could render, on top of `JSON.parse` over the same bytes.

The same read path also copied the whole 629 k-element event array three times to keep a few hundred elements: once in `historyCutOf`, once for the pagination window, and once more for the `seq >= cut` filter.

## Decision

`historyPage` emits a read-path projection of the page: an `assistant/chunk` is dropped when its own step's append-origin `assistant/message` sits at a LATER position on the same page. Supersession is positional, not per-step, which is the exact statement of the property and gives three guarantees for free — a delta recorded after its step's message is kept, a replacement copy settles nothing (it restates a shadowed range for the model and never entered the transcript), and the page's last event is never dropped, because no message can sit after it.

That last guarantee is load-bearing for the browser. `Session.loadOlder` asserts `tail.event.seq + 1 === baseSeq` and drops a page that violates it, and `acceptLiveEvent` treats `event.seq > tailSeq + 1` as a gap and refetches. Positional supersession keeps the page's final event at `beforeSeq - 1`, so neither path sees a hole; only interior delta positions disappear, which the assembler indexes by seq in a `Map` and does not require to be dense.

Two superseded positions still ship because no terminal event restates them:

- The step's first `isTokenDelta` chunk. Both `assistant-step` Definitions and the shared `indexAssistantStepTiming` fold stamp `firstTokenTime` from that exact event, and `AssistantTiming.firstTokenTime` is user-visible in the Trajectory. Keeping the first one preserves the value identically, because both folds take the first and ignore the rest.
- Every `usage` chunk. `trajectory-assistant-definition` accumulates chunk usage across an `llm/retry` (`usage: context.state.usage ?? match.event.data.usage`), so a retried step's Trajectory total is the sum of its attempts, which the final message's own `usage` does not restate.

Steps with no terminal message on the page keep every delta. That covers a step still streaming, a step interrupted before it produced a message — `finalNode` builds its `interrupted: true` node from chunk-derived blocks alone, so those deltas are its only record — and a step whose message falls beyond a page-up's upper bound.

The projection is a validated `Config` field on the gateway plugin, `historyElideSettledDeltas`, defaulting to `true`; a deployment diagnosing the raw stream sets `false` and receives every recorded chunk. Nothing about persistence changes: the log keeps every chunk, and what a model request reconstructs from it is untouched, so **model-visible ⟺ logged** holds unchanged. This changes only what a READ serves a client.

`paginate` locates both page bounds with a binary search over the seq-ascending log and returns one `slice`, and `historyCutOf` passes the attached session's cached frozen `events` snapshot straight through instead of spreading it. The three whole-array copies are gone; the synchronous-cut contract is untouched because no `await` was added or moved.

## What ui-trajectory needed

The audit flagged as unverified whether `ui-trajectory` Definitions need settled-step deltas. They do, in two places, and both are preserved above rather than broken: `updateChunk` is the only writer of `firstTokenTime`, which reaches the user as `AssistantTiming`, and it is the only writer of the accumulated `usage` a retried step reports. Everything else `ui-trajectory` folds from a settled step's chunks — `blocks`, `firstVisibleSeq`, `firstVisibleTime`, `sawChunk` — is either replaced by `toAssistantBlocks(message.content)` on the `assistant/message` arm or read only while the step has no settled node.

`session.history` and `subagent.history` have exactly one production consumer, the web client's `Session` object (`packages/client/runtime`). No host path, SDK, or ACP surface reads a history page.

## Testing

`packages/host/apiproxy/tests/api-proxy-history-deltas.spec.ts` pins the boundary: a settled step ships only its first token delta and its `usage` chunk while its other seven recorded chunks stay in the log; an in-flight step above a settled one ships all four of its deltas; a delta recorded after its step's message survives; a page with no assistant message is served unchanged; the reconstructed per-step terminal content equals what the unelided log yields; a page-up ends exactly at `beforeSeq - 1`; five 200-delta settled steps collapse from 1,020 chunks to ten while the page shrinks more than 20× in events and 4× in bytes; and `historyElideSettledDeltas: false` serves every recorded event.

`packages/host/apiproxy/tests/session-export.spec.ts` pins the config field's default, opt-out, and rejection of a non-boolean.

The pagination regression test in `api-proxy-view.spec.ts` now runs with the projection off, so it keeps asserting the raw cut it was written for.

## Alternatives considered

**Drop every chunk of a settled step.** The largest saving and it breaks two user-visible facts: first-token timing goes null for every settled step, and a retried step's Trajectory usage silently changes from the accumulated total to the final attempt's. Two tiny events per step buy exact fidelity.

**Add an `include` selector to the history request so the browser asks for a chunk-free page.** A wire-contract change and a client change for a decision the host can make correctly on its own; it also lets a client ask for a page whose in-flight step has no content. The host knows which deltas are superseded; the client does not.

**Elide only the delta payload bodies, keeping the events.** Preserves seq density, and keeps the per-event cost the measurement shows to be dominant: 8,779 envelopes still parse, validate, match, and fold. It also produces events whose declared type no longer describes their content.

**Serve settled deltas on demand through a second call.** No consumer wants them. Adding a retrieval surface for data nothing reads is cost without a customer; the config flag covers the one real case, a deployment debugging the raw stream.

**Special-case the page's last event instead of comparing positions.** A guard that the ordering invariant already makes unreachable, so it could never be tested. Positional supersession states the property directly and yields the same guarantee.

**Assume `seq === index` and slice arithmetically** (the audit's suggestion for `paginate`). Correct today for a session log, and it silently mis-slices any array that does not start at seq 0. The binary search costs `log n` on a path already doing `n` work and needs no such assumption.

## Consequences

The measured 50-message tail page for the largest local session falls from 8,779 events / 3,165,545 B to 455 events / 880,455 B — 19.3× fewer events and 3.60× fewer bytes — and assembling it through the real `ConversationNodeAssembler` plus `ChatSnapshotBuilder` falls from 63.4 / 38.2 / 44.2 ms to 2.8 / 2.8 / 2.3 ms. Every settled assistant step's reconstructed terminal content is byte-identical across the two pages (36 steps, 87,538 B). Removing the three array copies takes another whole-log spread per read off the synchronous cut.

A client can no longer replay a settled step's token-by-token arrival from history; it renders the finished message instead, which is what it rendered before once the message landed. Anything needing the raw stream reads the log, or runs with `historyElideSettledDeltas: false`.

The elision is decided per page, not per session, so a step straddling a page boundary keeps its deltas on the page that lacks its message. That is conservative in the right direction: the page a client holds always contains enough to render what it shows.

The `session.history` cost the audit measured next — reading, parsing and freezing the whole log to serve 50 messages — is untouched and still dominates a cold open.

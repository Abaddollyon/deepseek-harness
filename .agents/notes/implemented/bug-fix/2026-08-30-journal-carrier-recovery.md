# Agent Note: Journal carrier recovery stays generation-owned

Status: implemented

English | [中文](2026-08-30-journal-carrier-recovery.zh.md)

## Problem

A journal follow can lose its carrier before yielding the opening cursor. The journal must recover that transport loss without publishing a partial window, duplicating an accepted frame, or converting a healthy live transport into a domain failure.

## Decision

RemoteStream owns carrier recovery. A RemoteStreamCarrierError causes one immediate replacement when a Connection generation is available; the replacement follow supplies the atomic snapshot and tail. RemoteJournalStream publishes only the accepted opening snapshot, and its cursor and protocol checks remain unchanged. RemoteStreamError, malformed frames, cursor violations, and other domain failures remain terminal: before an opening is accepted they reject open() with the exact error identity, and afterward they reach failed deterministically.

## Alternatives considered

**Retry terminal journal failures in RemoteJournalStream.** Rejected because business and protocol errors are domain-owned, and retrying them could duplicate accepted frames or hide a permanent failure.

**Refetch a page after a pre-opening transport loss.** Rejected because session.follow owns snapshot and tail atomically; a page cannot replace that opening contract.

**Add a second journal lifecycle controller.** Rejected because generation replacement, cancellation, and disposal already share the RemoteStream lifecycle controller.

## Consequences

- A pre-opening carrier loss is recovered without a journal failure callback or duplicate publication.
- A healthy replacement opening is the only published window for the recovered generation.
- The existing bounded carrier retry and Connection backoff remain the only recovery timing controls.
- Domain and cursor failures before opening reject open() with their exact identity; failures after opening reach the journal failure callback.

## Verification

The Client journal suite covers a carrier loss before the opening cursor followed by an immediately healthy generation, asserting two follow attempts, one replacement publication, and no failure callback. Existing coverage preserves exact-identity open() rejection for pre-opening terminal failures, failure callbacks after an accepted opening, plus replacement, burst, and disposal behavior.

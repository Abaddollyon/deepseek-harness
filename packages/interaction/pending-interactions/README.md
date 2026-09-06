---
description: "Content-free Host registry for passive status consumers that need current approval and question lifecycle without joining answerer waterfalls."
kind: "package-reference"
---

# @deepseek-ai/dsh-pending-interactions

English | [中文](README.zh.md)

## Summary

`dsh-pending-interactions` owns `ctx.pendingInteractions`, a Host registry that exposes which approval, question, or plan-review requests are currently waiting for a human. It carries identity and lifecycle only: request text, tool arguments, answer callbacks, waterfall continuations, and outcomes never enter this service.

## Table of Contents

- [Service: `PendingInteractionRegistry` (ctx key: `pendingInteractions`)](#service-pendinginteractionregistry-ctx-key-pendinginteractions)
- [Lifecycle](#lifecycle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-pendinginteractionregistry-ctx-key-pendinginteractions"></a>
## Service: `PendingInteractionRegistry` (ctx key: `pendingInteractions`)

### Public API

- `begin({ kind, agent? }): () => void` records a pending interaction and returns its idempotent end capability.
- `snapshot(): PendingInteractionSnapshot` returns the activation epoch, current revision, and pending records.
- `onChange(listener): () => void` observes future revisioned begin/end changes and returns an unsubscribe capability.

`PendingInteractionObserver` is the read-only `snapshot()` plus `onChange()` face for status consumers. A record contains only opaque `id`, `kind`, optional `agentId` and `sessionId`, and `startedAtMs`; an end change adds `endedAtMs`. The epoch changes when the Host service remounts, and revisions increase within one epoch.

<a id="lifecycle"></a>
## Lifecycle

Approval and user-question services call `begin()` only around actual answerer dispatch. They end the record on answer, rejection, unavailable provider, error, or cancellation. The registry also clears an agent's records on `agent/disposed` and clears all records on its own disposal. Observer delivery is queued and failure-contained, so an observer cannot answer, delay, or replace the interaction result.

## Model Experience

None, as the registry exposes process-local lifecycle metadata only to passive Host consumers.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process-local lifecycle only** — reconnecting consumers start from the current snapshot; ended records are not durable history.
- **Agentless questions lack session identity** — they remain observable by opaque id and kind, but no live Agent exists from which to derive agent or session identity.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

No runtime invariant companion is published; the registry's snapshot and queued change stream are two views of the same atomic mutation, and its package tests check revision, cleanup, and observer isolation directly.

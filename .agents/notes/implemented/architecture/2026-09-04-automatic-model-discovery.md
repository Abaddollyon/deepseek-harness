# Agent Note: Automatic provider model discovery

Status: implemented

English | [中文](2026-09-04-automatic-model-discovery.zh.md)

## Problem

Provider releases can precede the installed pi-ai catalog. Static configuration then hides models from every consumer of the LLM service, while separate picker catalogs can expose models that dispatch cannot resolve.

## Decision

The [pi-ai adapter](../../../../packages/llm/llm-pi-ai/README.md) owns opt-in authenticated discovery and a shared immutable effective catalog. Explicit model entries and overrides win over normalized live metadata, which wins over installed capacities and advertised capabilities; the exact installed model still supplies wire compatibility. Unknown IDs receive the configured route's protocol and conservative capacity/modality defaults. Discovery neither edits settings nor selects a model.

Each route owns one refresh, cancellation controller, timer, and configuration/credential-scoped metadata cache. Startup restores usable disk metadata before network discovery. Credential notifications fence stale requests; an OAuth rotation within the refresh's own serialized `Models.getAuth` operation continues with that new grant. Other account mutations still invalidate it. Publication replaces the adapter registration after metadata commits, reusing `llm/adapters-updated` and its contained observer dispatch. Captured request snapshots remain immutable. Disposal joins pending work.

Codex metadata negotiates with the current stable version advertised by the public official npm package endpoint. The public request has no provider authentication, allows no redirects, and consumes a bounded portion of the refresh deadline. A cached successful version survives lookup failures. Metadata negotiation does not change pi-ai execution headers or prove compatibility of a newly advertised model. Only allowlisted normalized fields survive; provider prompts, instructions, and unknown fields are discarded. Hidden/internal and explicitly unsupported Codex response rows are excluded from adoption.

## Alternatives considered

**Rewrite model configuration on refresh.** Rejected because discovery would overwrite explicit choices and turn transient provider replies into user settings.

**Maintain picker-specific catalogs.** Rejected because chat, delegation, automation, and remote configuration must resolve through the same dispatch service.

**Pin a permanent Codex discovery version.** Rejected because server-side version filtering can hide new models despite successful authentication. Public version negotiation keeps discovery current, at the cost of requiring separate provider execution verification.

## Consequences

Offline caches and per-route failure containment preserve availability. Metadata is not a model execution canary; unknown protocol behavior still requires a harmless real-provider request. Installed and explicit models remain useful fallbacks, and unknown reasoning support stays conservative. The optional caches are versioned and owner-only, with no credentials or remote instruction bodies stored. Focused tests cover real Loader composition, selectable/dispatchable agreement, overrides, OAuth refresh, coalescing, cancellation, periodic work, stale-account fencing, offline restore, protocol pagination/bounds, and secret omission.

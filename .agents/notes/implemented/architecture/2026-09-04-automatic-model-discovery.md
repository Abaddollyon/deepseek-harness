# Agent Note: Automatic provider model discovery

Status: implemented

English | [中文](2026-09-04-automatic-model-discovery.zh.md)

## Problem

Provider releases can precede the installed pi-ai catalog. Static configuration then hides models from every consumer of the LLM service, while separate picker catalogs can expose models that dispatch cannot resolve.

## Decision

The [pi-ai adapter](../../../../packages/llm/llm-pi-ai/README.md) owns opt-in authenticated discovery and a shared immutable effective catalog. Explicit model entries and overrides win over normalized live metadata, which wins over installed capacities and advertised capabilities; the exact installed model still supplies wire compatibility. Unknown IDs receive the configured route's protocol and conservative capacity/modality defaults. Discovery neither edits settings nor selects a model.

A request-supplied reasoning effort is strict. When the request omits an effort, a route-wide default applies only if the exact resolved model supports it; otherwise dispatch omits the reasoning option and uses the provider/model default. This lets conservative discovered models remain usable without inventing capability, adding a synthetic `off` choice, or weakening explicit requests.

Each route owns one refresh, cancellation controller, timer, and configuration/credential-scoped metadata cache. Startup restores usable disk metadata before network discovery. Credential notifications fence stale requests; an OAuth rotation within the refresh's own serialized `Models.getAuth` operation continues with that new grant. Other account mutations still invalidate it. Publication replaces the adapter registration after metadata commits, reusing `llm/adapters-updated` and its contained observer dispatch. Captured request snapshots remain immutable. Cache identity includes the provider-resolved API-key auth and the credential references queried during resolution, so ambient-key rotation cannot restore another account’s models. OAuth cache identity reads the stored grant without refreshing it. The whole-operation deadline races every awaited phase and fences late read-only results. Cache writes use private staging files and serialized commits; disposal drains started filesystem writes but detaches uncancellable read-only dependencies. Native filesystem operations already started cannot be forcibly cancelled.

Known-model operations capture immediately. Unknown IDs on enabled routes wait for the cache-restore stage, then the bounded shared refresh only if still missing. Caller abort cancels that wait; restored IDs do not depend on the network request finishing. Readiness completes before an immutable dispatch snapshot is captured. The optional credentials service becoming ready invalidates earlier startup auth reads, so real Loader ordering cannot strand a cold process outside its account cache.

Codex metadata negotiates with the current stable version advertised by the public official npm package endpoint. The public request has no provider authentication, allows no redirects, and consumes a bounded portion of the refresh deadline. A cached successful version survives lookup failures. Metadata negotiation does not change pi-ai execution headers or prove compatibility of a newly advertised model. Only allowlisted normalized fields survive; provider prompts, instructions, and unknown fields are discarded. Validated negative eligibility is retained separately from capabilities so installed fallbacks and last-good metadata cannot resurrect hidden/internal or explicitly unsupported choices. Explicit entries/overrides remain authoritative; saved selections retain their dispatch descriptors. Omitted rows preserve state, and valid positive rows clear exclusions. Metadata and exclusions share account/configuration fencing, durable restore, verified renewal migration, and aggregate bounds.

The Models settings editor exposes the per-route automatic-discovery switch while preserving explicit model entries and unknown configuration fields. Its manual **Fetch available models** control remains a separate draft/adoption flow. Browser model pickers share a catalog that coalesces stale-on-open and explicit refreshes, retains last-good rows on partial failure, and preserves the selected route. The composer adds compact provider/model search and a quiet refresh action without changing Model→Effort navigation; `/model` uses the command shell's search over the same refreshed catalog. Delegation keeps its separate staged catalog, refreshes after credentials, adapter, settings, reconnect, and stale-open signals, and preserves drafts plus unavailable configured rows.

## Alternatives considered

The shared renewal-only auth injection observes predecessor and successor grants inside serialized provider refresh transactions, then verifies the committed successor. It serves discovery, request-time generation auth, and forced recovery, but not login. Only a predecessor matching the current cache identity preserves metadata and the Codex version. Migration writes normalized data under the successor fingerprint; per-route write sequences fence delayed migrations against newer catalog commits. Unobserved external replacements remain invalidations rather than inferred same-account renewals. Cache migration errors leave generation auth valid and remain retryable by discovery.

**Rewrite model configuration on refresh.** Rejected because discovery would overwrite explicit choices and turn transient provider replies into user settings.

**Maintain picker-specific catalogs.** Rejected because chat, delegation, automation, and remote configuration must resolve through the same dispatch service.

**Pin a permanent Codex discovery version.** Rejected because server-side version filtering can hide new models despite successful authentication. Public version negotiation keeps discovery current, at the cost of requiring separate provider execution verification.

## Consequences

Offline caches, last-good picker rows, and per-route failure containment preserve availability. Metadata is not a model execution canary; unknown protocol behavior still requires a harmless real-provider request. Installed and explicit models remain useful fallbacks, and unknown reasoning support stays conservative. The optional caches are versioned and owner-only, with no credentials or remote instruction bodies stored. Focused tests cover real Loader composition, selectable/dispatchable agreement, overrides, OAuth refresh, coalescing, cancellation, periodic work, stale-account fencing, offline restore, protocol pagination/bounds, secret omission, picker search and keyboard behavior, settings-field preservation, and delegation draft preservation.

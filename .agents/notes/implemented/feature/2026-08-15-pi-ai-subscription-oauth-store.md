# Agent Note: pi-ai subscription OAuth uses DSH-owned provider records

Status: implemented

English | [中文](2026-08-15-pi-ai-subscription-oauth-store.zh.md)

## Problem

pi-ai already implements the Codex and Anthropic OAuth protocols, token refresh, and provider-native request formats, but dsh-llm-pi-ai constructed every Models collection without a credential store. An openai-codex route therefore had no usable authentication path unless a deployment supplied an expiring token as apiKeyEnv, and an anthropic route could use only its API-key path. A sidecar could proxy both subscriptions, but that duplicated transport, supervision, and failure behavior around protocols already present in the in-process adapter.

OAuth refresh is a read-modify-write transaction. A normal credential reference resolves one value at a time and cannot prevent two Harness processes from refreshing the same expired token from one stale snapshot. A single shared JSON map also makes unrelated provider writers overwrite one another unless every provider uses one global commit lock.

## Decision

dsh-llm-pi-ai owns a persistent pi-ai CredentialStore under $DSH_HOME/credentials/pi-ai-v1. Each provider uses one SHA-256-named JSON record containing a format version, the unhashed provider id, and the complete pi-ai credential. The directory is owner-only and each replacement file is owner-readable and owner-writable. Reads validate the embedded provider id, record version, credential discriminator, required token fields, JSON-safe provider extensions, file kind, and POSIX permission bits before returning a credential.

Same-provider mutations serialize through an in-process promise chain and a provider-file lock held across the fresh read, pi-ai refresh callback, validation, and atomic replacement. Different providers use different files and locks, so their refreshes do not share a commit point. A callback returning undefined leaves the current credential unchanged, matching pi-ai refresh semantics; logout uses the separate locked delete operation. list() returns only sorted provider/type metadata.

One store instance belongs to one dsh-llm-pi-ai plugin instance and is passed into every immutable Models snapshot. Settings changes still rebuild provider/model collections without resetting credentials. A route with apiKeyEnv keeps the Harness API-key override; a route without it lets pi-ai resolve stored OAuth. The configurable-provider directory includes catalog providers that declare either API-key or OAuth authentication, including openai-codex and anthropic.

Interactive login remains a trusted-host responsibility. The package exports PiAiOAuthCredentialStore for a Node host that drives pi-ai AuthInteraction; the LLM request and replay capabilities never expose credentials.

## Alternatives considered

- **Keep CLIProxyAPI as the only subscription route:** retained only as a reversible fallback because it adds a supervised process and an OpenAI-compatible translation layer around provider implementations pi-ai already owns.
- **Store OAuth inside the generic credential-reference service:** rejected because its resolve/set/unset API does not provide the cross-process callback transaction pi-ai refresh requires.
- **Use one pi-ai-compatible auth.json map:** rejected because independent provider refreshes would need one global lock and one shared lost-update domain.
- **Copy Codex or Claude CLI files directly at request time:** rejected because those files have different owners and lock protocols; import/login belongs to an explicit trusted-host operation.

## Consequences

Native subscription routes and proxy routes can coexist while deployments migrate. Route identity is the credential key, so aliases do not automatically share credentials. Store errors fail closed and use non-secret diagnostics; malformed or over-permissive records are not silently replaced. The shared atomic writer publishes complete files by rename but does not fsync them, so sudden power loss can lose the latest replacement without exposing partial JSON. The current file-lock helper also fails closed after its bounded wait and never steals an orphaned lock; long refresh and explicit orphan recovery remain operational constraints.

## Verification

Package tests cover CRUD, metadata-only listing, callback-undefined behavior, callback failure preservation, same-provider serialization, different-provider overlap, owner-only modes, broadened-mode refusal, malformed JSON redaction, provider-id mismatch, OAuth route discovery, existing API-key routes, configuration reload, composition, replay, conversion, discovery, and adapter behavior. The package TypeScript build compiles the credential store and dependency references under the normal workspace program.

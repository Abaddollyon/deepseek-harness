# Agent Note: Proxy pool routes

Status: implemented

English | [中文](2026-10-02-proxy-pool-routes.zh.md)

## Problem

A pool that owns provider accounts — a Codex pool or a Claude subscription pool — sits behind the catalog route keys `openai-codex` and `anthropic`, because saved sessions and defaults name those keys. On such a route, pi-ai's catalog auth reads stored sign-ins, refreshes stored OAuth grants, and reads ambient provider variables, so the Harness could compete with the pool as refresh owner or send a credential the pool never issued. pi-ai also selects Claude Code request formatting only for a key containing `sk-ant-oat` and refuses a keyless Anthropic request, so a keyless Claude pool could not be reached at all. Model discovery answered both route keys from the installed catalog, so models and reasoning efforts the pool serves were invisible.

## Decision

`dsh-llm-pi-ai` routes take three explicit options, each defaulting to the previous behavior. `authMode: proxy` builds the route with the Harness api-key method alone, and the adapter's collection answers "nothing stored" for that route id and refuses a credential write, so no stored grant is read or refreshed and no ambient variable is consulted; the request carries the `apiKeyEnv` value or nothing. Proxy mode requires an explicit http(s) `baseURL` without embedded credentials. `anthropicRequestMode: claude-code`, valid only on `anthropic-messages` routes, sets pi-ai's Anthropic `requestMode` stream option. `modelDiscovery.source` makes the existing discovery operation list the route's own endpoint with an OpenAI-compatible or Anthropic listing and map reported modalities, reasoning efforts, and Anthropic adaptive thinking (as `compat.forceAdaptiveThinking`), dropping efforts pi-ai cannot express.

The `requestMode` option is a hunk in the existing pnpm patch for pi-ai. It applies the identity headers, beta features, system preamble, and tool-name mapping an OAuth token selects, sends a non-OAuth key as `X-Api-Key`, and for a keyless request passes an empty bearer token with both auth headers nulled so the Anthropic SDK neither resolves ambient credentials nor sends one.

## Alternatives considered

**A placeholder key containing `sk-ant-oat`.** It selects the format on stock pi-ai, but a fake credential that changes behavior by its spelling is invisible configuration and breaks once pi-ai changes the check.

**Detecting the pool from its host, port, or a marker header.** Deployment addresses differ, and a marker header reaches the upstream provider; the mode must be stated, not inferred.

**A periodic catalog refresher in `dsh-llm-pi-ai`.** pi-ai's own refresh reads and refreshes the route's stored credential, and a Harness-owned refresher would add a second model registry. A plugin calls the existing discovery operation and writes the result into settings instead.

## Consequences

- Pool routes work from configuration on the released runtime without rewriting installed JavaScript.
- The pi-ai patch file now carries two changes and must be re-applied on every pi-ai upgrade until pi-ai ships an equivalent option.
- `LlmDiscoveredModel` gains `reasoningEfforts` and adapter-named `compat` switches; discovery still stores nothing, so a refresh never changes defaults, credentials, or a session's model.

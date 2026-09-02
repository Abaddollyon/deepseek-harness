---
description: "The Codex subscription search provider for ctx.web: strict app-server replay, bounded results, redacted failures, and process-tree cleanup."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-codex

English | [中文](README.zh.md)

## Summary

This Cordis plugin registers the fixed codex search provider through ctx.web and runs one ephemeral Codex app-server process per request. Choose it when a signed-in Codex CLI subscription should supply web search without API-key configuration. It has no fallback chain and never reads credential files.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in a composition that already loads the web and subprocess services, then select searchProvider: codex. Run codex login outside DSH first. DSH never reads ~/.codex, authentication files, credentials, or keychains and never performs login or a probe search.

| Field | Default | Bounds and meaning |
|---|---|---|
| cwd | process.cwd() | Existing working directory for the ephemeral thread |
| requestTimeoutMs | 60000 | Integer from 1 through 600000 |
| disposeGraceMs | 3000 | Integer from 1 through 60000 for process-tree termination |
| maxResults | 8 | Integer from 1 through 50 |
| maxPayloadBytes | 262144 | Integer from 1048 through 1048576 |
| executable | package-local wrapper | Bare command or absolute path |

Availability is only a synchronous configuration and filesystem hint. Every request resolves the executable asynchronously before launch. The default launch is Node plus the package-local OpenAI Codex wrapper followed by app-server and --stdio.

Completed structured webSearch items become HTTP or HTTPS sources. URLs are validated, deduplicated in first-seen order, capped, and optionally paired with the final agent answer. Caller abort reports WEB_ABORTED. Invalid frames, conflicting identifiers, failed turns, and missing structured items report WEB_PROVIDER_PROTOCOL. Stable nonzero-exit authentication evidence reports an actionable login message; raw diagnostics never enter user-facing errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The wire performs initialize and initialized, creates an ephemeral read-only thread with live web search and approval policy never, starts one turn, answers currentTime/read, rejects other server requests, and accepts notifications arriving before their request response. Thread and turn identifiers remain strictly correlated.

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Config schema, provider registration, and Fiber-owned disposer |
| [src/provider.ts](src/provider.ts) | Executable resolution, process lifecycle, error mapping, and normalization |
| [src/wire.ts](src/wire.ts) | Narrow JSON-RPC app-server protocol and correlation |
| [tests/fixtures](tests/fixtures) | Deterministic success, failure, and malformed replay records |
| — | No runtime invariant companion is published; the package owns no independent event stream or public mutable relation beyond behavior covered by loader and replay tests. |

Abort, timeout, normal completion, and Fiber disposal send a best-effort turn/interrupt when identifiers are known, close the transport, and terminate the complete process tree through ctx.subprocess. Disposal waits for quiescence before provider unregistration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — shared search request, result, and error vocabulary.
- [Web service](../web/README.md) — registry and provider-selection ownership.
- [Web tool](../tool-web/README.md) — model-facing rendering of sources and failures.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-codex) — exhaustive accepted fields.
- [Subscription provider Agent Note](../../../.agents/notes/proposed/architecture/2026-09-02-subscription-web-search-provider-contract.md) — process and protocol rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through dsh-tool-web, which gives the model bounded citeable sources and optional answer content or a stable redacted failure while keeping Codex credentials, CLI transcripts, stderr, and local authentication paths out of model context.

#### KV Cache effect

No direct invalidation; the consuming web tool owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only one query and one webSearch item are accepted per provider request; native Codex batching is deferred.
- Availability does not prove authentication because real login and search probes are intentionally forbidden.
- The narrow app-server schema is replay-pinned and must be updated when Codex changes its protocol.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Future protocol additions should remain provider-local until the Web seam has a provider-neutral field. Keep authentication classification narrow, keep raw process output redacted, and update exact replay fixtures with every accepted wire change.

</details>

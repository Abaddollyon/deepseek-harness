---
description: "Claude Code subscription web search for ctx.web through the official Agent SDK and managed subprocess seam."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-claude-code

English | [中文](README.zh.md)

## Summary

This plugin registers the fixed `claude-code` search provider with `ctx.web`. Each request runs one official Claude Agent SDK `query()` with only `WebSearch`, structured JSON output, no session persistence, and a bounded turn count. It uses the user's existing Claude Code subscription login without reading, copying, or probing credentials.

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

Load `web`, a `subprocess` implementation, and this plugin. Select it explicitly in the active profile with `web.searchProvider: claude-code` when more than one search provider is registered.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-web-search-claude-code'
  config:
    cwd: .
    requestTimeoutMs: 60000

web:
  searchProvider: claude-code
```

| Field | Default | Meaning |
|---|---:|---|
| `cwd` | `process.cwd()` | Working directory resolved and validated when a search starts |
| `requestTimeoutMs` | `60000` | Request deadline; safe integer from 1 through 600000 |
| `disposeGraceMs` | `3000` | Process-tree termination grace; safe integer from 1 through 60000 |
| `maxResults` | `8` | Normalized source cap; safe integer from 1 through 50 |
| `maxTurns` | `4` | Agent SDK turn cap; safe integer from 1 through 16 |
| `maxPayloadBytes` | `262144` | Serialized result cap; safe integer from 1048 through 1048576 |
| `executable` | SDK package default | Optional nonblank bare or absolute Claude executable override |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-claude-code) is the exhaustive declaration reference.

### Login and availability

DSH never reads `~/.claude/*`, keychains, environment credential stores, or provider tokens. Authentication remains owned by Claude Code; sign in outside DSH with `claude login`. `available()` is only a synchronous executable/configuration hint and deliberately does not run a search or authentication probe.

Stable authentication evidence returns exactly: `Sign in with Claude Code (claude login) and retry; DSH does not read provider credentials`.

A missing executable returns exactly: `Claude Code CLI is unavailable; install Claude Code and retry; DSH does not read provider credentials`.

### Results and failures

The provider requires exactly one matching raw `WebSearch` result plus one successful structured result. It normalizes HTTP(S) sources, deduplicates URLs, applies source and UTF-8 payload caps, and returns the grounded answer as `content`. Missing, duplicate, malformed, or mismatched protocol data returns `WEB_PROVIDER_PROTOCOL`; cancellation returns `WEB_ABORTED`; timeouts and redacted execution failures return `WEB_PROVIDER_ERROR`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Design philosophy

- **Subscription authentication stays provider-owned.** The adapter never translates Claude credentials into a Harness secret.
- **All processes stay seam-owned.** The Agent SDK's custom spawn callback projects through `ctx.subprocess`, so one managed process tree exists per query.
- **Only public, bounded errors cross the seam.** Raw SDK, resolver, stderr, and filesystem errors are classified and discarded rather than attached as serializable causes.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, fixed-ID registration, and effect-scoped lifecycle |
| [`src/provider.ts`](src/provider.ts) | Agent SDK protocol, normalization, error classification, and process cleanup |
| [`tests/provider.spec.ts`](tests/provider.spec.ts) | Keyless SDK replay, protocol, redaction, race, and cleanup coverage |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Loader registration, duplicate rejection, blocked-startup disposal, and public re-exports |
| — | No runtime invariant companion is published; this adapter owns no independent event sequence or mutable data relation beyond contracts enforced by the web and subprocess seams. |

### Lifecycle

Registration yields two LIFO cleanups: provider disposal runs first, aborts all active controllers, and waits for every query/process tree to settle; only then does the registry disposer unregister `claude-code`. Abort checks surround executable resolution and SDK startup, while a spawned child is recorded synchronously before any later await, so teardown cannot lose a process.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — shared search contracts and provider selection.
- [Web package map](../README.md) — the provider package family.
- [Subprocess package](../../subprocess/subprocess/README.md) — managed process-tree contract.
- [Public adapter exports decision](../../../.agents/notes/implemented/architecture/2026-09-02-claude-code-adapter-public-exports.md) — why the shared Claude adapter helpers are package API.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, the model receives a concise grounded answer and bounded citation sources while public failures expose only stable codes and actionable messages.

#### KV Cache effect

No direct invalidation; the web tool owns any prompt-prefix presentation.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Claude Code must already be installed and signed in** — this plugin never performs login or credential discovery.
- **Only `WebSearch` is enabled** — file, shell, MCP, and other Agent SDK tools are intentionally unavailable.
- **One query creates one process** — there is no session reuse, batching, fallback provider, or coordinator.
- **`cwd` is provider configuration** — `WebSearchRequest` carries no session working directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep replay tests keyless. New SDK message shapes must first be captured as bounded fixtures and must not weaken the exactly-one raw `WebSearch` rule or the no-public-cause rule.

</details>

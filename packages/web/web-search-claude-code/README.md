# @deepseek-ai/dsh-web-search-claude-code

English | [中文](README.zh.md)

Official subscription-native Claude Code web-search provider for [`ctx.web`](../web/README.md). It uses `@anthropic-ai/claude-agent-sdk`, enables only Claude Code's `WebSearch` tool, and runs every ordered query batch in one ephemeral SDK query with `permissionMode: 'dontAsk'` and `persistSession: false`. The SDK and its Claude Code process own authentication; this package never reads, copies, logs, exports, or relays OAuth tokens and never falls back to an API-key provider.

The provider maps citations only from structured `WebSearch` tool results. The final SDK structured output may add a grounded answer, but cannot invent source URLs. Missing, duplicate, reordered, or malformed query data becomes a safe `WEB_PROVIDER_PROTOCOL` outcome. The web seam performs final HTTP(S) filtering, canonicalization, deduplication, caching, singleflight, and source caps. One provider failure has no hidden retry.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `cwd` | Host process cwd | Working directory passed to the official SDK. |
| `graceMs` | `3000` | Managed process-tree termination grace. |
| `maxTurns` | `4` | Maximum SDK conversation turns for one native batch. |

The plugin injects `web` and `subprocess`. Custom SDK spawn is projected onto the shared subprocess owner so cancellation closes the SDK query, terminates the complete process tree, and waits for process settlement before returning. `available()` is a search-free package readiness check; authorization errors remain inside the official runtime and surface as safe provider failures.

## Model Experience

### Native Claude search query

#### What the model sees

One Agent SDK query receives a generated instruction containing the ordered cache-miss queries and supported domain controls, plus the structured-output schema. It receives no DSH conversation history, provider credential, OAuth token, or resumed SDK session, and can invoke only `WebSearch`.

#### Token effect

One subscription-native Claude query is used per coordinated miss batch and `maxTurns` bounds its turns. The official SDK owns usage accounting; there is no API-key search request or retry.

#### KV Cache effect

The query has no persisted or resumed session, so native search batches share no retained conversation prefix and do not affect the DSH conversation model's cache.

### Conversation tool result, indirectly

#### What the model sees

Indirectly through `@deepseek-ai/dsh-tool-web`: successful answers, normalized citations, and safe partial failures are retained in the logged tool result. Provider and process details are not added to the model-facing schema or prompt.

#### Token effect

Adds no prompt tokens before use. Each call adds the consumer-rendered successful answers, capped citations, and safe per-query failures to the logged tool result.

#### KV Cache effect

Append-only after the reusable conversation prefix; retained search results follow the tool consumer's compaction behavior.

## Known Limitations and Deferred Work

- Claude Agent SDK `WebSearch` exposes allowed/blocked domains but no native freshness, location, or result-count parameter. Domain controls and location are included in the exact batch instruction; the provider also post-filters every citation by allowed/blocked hostname, so a disallowed source cannot reach the caller even if the model omits a tool argument. Upstream search may still inspect a disallowed result, and geographic relevance cannot be independently enforced. The web seam enforces the result cap; freshness remains unsupported.
- Availability cannot inspect OAuth state without crossing the official authentication boundary, so authentication is verified only when the SDK runs.

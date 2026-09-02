# @deepseek-ai/dsh-web-search-codex

English | [中文](README.zh.md)

Official subscription-native Codex web-search provider for [`ctx.web`](../web/README.md). It launches the pinned official `@openai/codex` package as `codex app-server --stdio`, performs the official initialization handshake, creates one ephemeral thread, and runs one turn for every ordered query batch. Codex and its app-server own authentication; this package never reads, copies, logs, exports, or relays OAuth tokens and never falls back to an API-key provider.

At `thread/start`, the provider maps `live` to native `web_search: 'live'`, maps `cached`/`indexed`/omitted to `'cached'`, and enables boolean `tools.web_search`, then derives citations only from structured `item/completed` values whose item type is `webSearch`. Terminal assistant prose cannot create source URLs. Missing or duplicate search items become safe `WEB_PROVIDER_PROTOCOL` outcomes. There is no hidden retry. The web seam performs final HTTP(S) normalization, canonical deduplication, caching, singleflight, and source caps.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `cwd` | Host process cwd | Working directory supplied to the ephemeral app-server thread. |
| `graceMs` | `3000` | Managed process-tree termination grace. |

The plugin injects `web` and `subprocess`. Each native batch owns one official process, one ephemeral thread, and one turn. Cancellation requests `turn/interrupt` when the protocol ids are known, closes the JSON-RPC connection, terminates the complete managed process tree, and waits for process settlement before rejecting. `available()` is a search-free package readiness check; authorization errors stay inside the official runtime and surface as safe provider failures.

## Model Experience

### Native Codex search turn

#### What the model sees

One ephemeral Codex thread receives a generated instruction containing the ordered cache-miss queries plus domain and location guidance; freshness is configured on the thread and the web seam caps results. It receives no DSH conversation history, provider credential, OAuth token, or prior search session.

#### Token effect

One subscription-native Codex turn is used per coordinated miss batch. The official runtime owns usage accounting; there is no API-key search request or retry.

#### KV Cache effect

The thread is ephemeral and never resumed, so native search batches share no persisted conversation prefix and do not affect the DSH conversation model's cache.

### Conversation tool result, indirectly

#### What the model sees

Indirectly through `@deepseek-ai/dsh-tool-web`: successful normalized citations and safe partial failures are retained in the logged tool result. Provider, process, account, and protocol details are not added to the model-facing tool schema or prompt.

#### Token effect

Adds no prompt tokens before use. Each call adds the consumer-rendered successful answers, capped citations, and safe per-query failures to the logged tool result.

#### KV Cache effect

Append-only after the reusable conversation prefix; retained search results follow the tool consumer's compaction behavior.

## Known Limitations and Deferred Work

- Pinned Codex accepts only a boolean `tools.web_search` value. Allowed/blocked domains and location are therefore included in the exact batch instruction; every returned citation is independently post-filtered by both allowed and blocked hostnames, with blocked domains taking precedence. Upstream search may still inspect a disallowed result, but it cannot reach the caller.
- The app-server's structured search result values are intentionally forward-compatible JSON. This provider retains only direct non-empty `url`, `title`, `snippet`, `publishedAt`, and `published_at` string fields and ignores unknown entries. It never derives a citation from terminal prose.
- Availability cannot inspect OAuth state without crossing the official authentication boundary, so authentication is verified only when app-server runs.

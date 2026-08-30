# Agent Note: pi-ai Pre-Content Auth Recovery

Status: implemented

English | [中文](2026-08-24-pi-ai-auth-recovery.zh.md)

## Problem

An OAuth provider can reject a token its own record still considers valid. The Codex deployment showed the concrete shape: DSH stores its own OAuth credential, another client sharing the same ChatGPT session refreshed and rotated the family, and for about ninety seconds the backend answered the stored access token with 401. pi-ai's `resolveStoredOAuth` refreshes only when the stored expiry has passed, so no refresh fired; the adapter classified the terminal error as `AUTH`; `dsh-llm-retry` does not list `AUTH` among its default retryable codes, so the turn died on the first attempt, three times in a row, until a later retry happened to land after the backend window closed. A transient auth-backend rejection became three user-visible turn failures with no automatic recovery.

## Decision

`@deepseek-ai/dsh-llm-pi-ai` recovers a pre-content auth rejection inside the adapter, per provider route, under a new `authRecovery` profile field (`retries` default 1, `delayMs` default 1000; `retries: 0` disables). When a stream's terminal failure classifies as `AUTH` before any chunk reached the caller, the adapter captures the rejected stored credential and refreshes it through the credential store's `modify` — the same exclusion pi-ai's own refresh runs under — only if the record still matches. A concurrent recovery that already rotated the record therefore supplies the retry token without a second refresh. API-key overrides never rotate an unrelated stored grant. The retried attempt re-resolves auth from the store, waits the configured delay, and replays the request.

The recovery sits in [`src/adapter.ts`](../../../../packages/llm/llm-pi-ai/src/adapter.ts) as an attempt loop around one extracted per-attempt generator. The terminal `usage` chunk is held back one step so an abandoned attempt's accounting never reaches the caller, while a successful or exhausted attempt still emits `usage` before `finish`. A forced-refresh failure does not stop the retry: a token-endpoint outage says nothing about whether the resource endpoint still rejects the stored credential, so the retried request answers that question. An attempt-local pi-ai collection records the exact stored credential its lazy auth supplies, and the route's integer `streamIdleTimeoutMs` bounds both credential-store serialization and the refresh network call. The plugin wires an `onAuthRecovery` observer to its logger so the cycle is visible in host logs ([`src/index.ts`](../../../../packages/llm/llm-pi-ai/src/index.ts)).

### Why pre-content only

Once any chunk has streamed, replaying the request would duplicate content the loop may already have made durable, so a mid-stream auth failure reaches the turn unchanged. A 401/403 arrives before content in practice — the status line precedes the body — so the restriction costs nothing in the observed cases and keeps the retry semantics identical to `dsh-llm-retry`'s "failed chunks never enter derived messages" rule.

### Why the adapter, not the retry plugin

`dsh-llm-retry` executes at the closed-step extension point: a turn-level retry rebuilds the whole request, re-bills the full context, and opens a new numbered turn. Auth recovery needs something turn-level retry cannot do at all — force a credential refresh before pi-ai's expiry check would — and the common cases (rotated family, backend blip) recover with one cheap re-request. Deployments that want a second net can still add `AUTH` to a profile's `retryPolicy.retryableCodes`; the two layers compose because an exhausted adapter recovery surfaces `AUTH` exactly as before.

## Alternatives considered

- **Make `AUTH` a default retryable code in `dsh-llm-retry`** — rejected: it retries every provider family at turn granularity, re-sending the full context per attempt, and still cannot refresh a credential pi-ai considers unexpired. Available per profile for deployments that want it.
- **Refresh on every 401 without retrying** — rejected: a refresh whose token endpoint is momentarily unreachable would strand an otherwise-valid credential, and a pure backend blip needs no rotation; the retry covers both.
- **Intercept inside pi-ai (upstream patch)** — rejected: pi-ai flattens provider errors to message text before the adapter sees them, and the harness-owned credential store is the correct place to persist the rotation; an upstream change could not see either.
- **Proactive refresh when another client rotates the family** — rejected: there is no signal for it; the 401 is the earliest observable fact.

## Consequences

A pre-content 401/403 costs one refresh call, one configured delay, and one extra request before a turn can fail with `AUTH`; a deployment that wants the old posture sets `authRecovery: { retries: 0 }`. API-key routes get the retry without a refresh (there is nothing to rotate), which covers pure auth-backend blips. What this does not fix: a genuinely invalidated refresh token still fails with `invalid_grant`, the retry fails, and the route needs a fresh sign-in — now observable through the `onAuthRecovery` log line instead of an unexplained bare `AUTH`.

## Testing

`packages/llm/llm-pi-ai/tests/auth-recovery.spec.ts` drives real compositions through a scripted HTTP mock: transparent recovery on 401-then-success, budget exhaustion surfacing `AUTH`, `retries: 0` disabling, multi-attempt budgets, non-auth failures left to the turn layer, one forced OAuth refresh rotating the stored credential and the next request's bearer token, request-time OAuth rotation capture, concurrent rotation suppressing a redundant refresh, API-key and keyless non-OAuth isolation, idle-bounded production credential-store acquisition and token endpoint calls, cancellation preventing a late durable commit, and a failed refresh falling through to the retry. `config.spec.ts` pins the resolved defaults and the write-time rejection of an invalid budget. Existing 401 adapter tests now script the retry's second request. No snapshot fixture: nothing model-visible changes — the recovered attempt is the same request — and the failure path's transcript surface is unchanged.

## Related

- [`dsh-llm-retry`](../../../../packages/llm/llm-retry/README.md) owns turn-level recovery and its `llm/retry` durable events.

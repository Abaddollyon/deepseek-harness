---
kind: upgrade-guide
description: "Model-request retries spread their waits by default, wait maxDelayMs instead of ending a turn on a longer provider delay, and pi-ai failures carry their HTTP status."
---

# Model-request retries spread their waits and honour provider delays

English | [中文](guide.zh.md)

## Change

Provider `retryPolicy.backoff` accepts `jitter: full | symmetric`. The default changes from symmetric jitter with `jitterRatio: 0.1` to `jitter: full` with `jitterRatio: 1`. For exponential delay `d`, a local wait falls in `[0, d]` instead of `[0.9 d, 1.1 d]`. For an accepted provider delay `p`, the wait falls between `p` and `min(p + max(d, p), maxDelayMs)` instead of exactly `p`. Agents answered by one rate-limit burst no longer retry together.

A provider delay above `maxDelayMs` waits exactly `maxDelayMs` in both modes. Before, normal mode ended the turn on it, and always mode used local backoff.

`dsh-llm-pi-ai` routes on `anthropic-messages`, `azure-openai-responses`, `mistral-conversations`, `openai-codex-responses` over SSE, `openai-completions`, `openai-responses`, and `pi-messages` attach `status` and `providerRetryAfterMs` to a failure that follows an error response. Error text the adapter does not recognize after a 408, 429, or 5xx fails as retryable `TIMEOUT`, `RATE_LIMIT`, or `SERVER` instead of `PI_AI_ERROR`. pi-ai's Codex sentence `You have hit your ChatGPT usage limit…` fails as `QUOTA` instead of `PI_AI_ERROR`; normal mode retries neither code. A profile may set `maxConcurrentRequests`; omitting it leaves the route unlimited.

Deployments that use the default backoff, depend on long `Retry-After` values ending a turn, or match `PI_AI_ERROR` codes from these routes are affected.

## Migration

1. To keep the previous wait times, set the backoff on each provider's `retryPolicy` in `cordis.yml` or its patch, keeping the policy's existing `mode`:

   ```yaml
   retryPolicy:
     mode: normal
     backoff:
       jitter: symmetric
       jitterRatio: 0.1
   ```

2. To bound retries after a provider delay above `maxDelayMs`, lower `retryPolicy.maxRetries`; no setting ends the turn on a long delay.
3. Replace consumer checks for `PI_AI_ERROR` on pi-ai HTTP failures with `TIMEOUT`, `RATE_LIMIT`, `SERVER`, or, for Codex usage limits, `QUOTA`.
4. Confirm the migration: each `llm/retry` session event's `delayMs` lies in the range above, and a Codex usage-limit failure ends its turn with code `QUOTA`.

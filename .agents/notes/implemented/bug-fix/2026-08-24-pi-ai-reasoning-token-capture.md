# Agent Note: Capture provider-reported reasoning tokens in the pi-ai adapter

Status: implemented

English | [中文](2026-08-24-pi-ai-reasoning-token-capture.zh.md)

## Problem

pi-ai reports a reasoning/thinking token split for the providers that expose one: OpenAI-completions routes always carry `usage.reasoning` from `completion_tokens_details.reasoning_tokens` (zero when the model did not think), OpenAI Responses routes read `output_tokens_details.reasoning_tokens`, Anthropic routes read `output_tokens_details.thinking_tokens`, and Google Generative AI and Vertex routes read `usageMetadata.thoughtsTokenCount`. The pi-ai adapter's `mapUsage` discarded that field, so every session routed through pi-ai recorded usage without `reasoningTokens` even though `TokenUsage` has carried the optional field since the DeepSeek adapter began populating it. Consumers folding session logs — cross-session usage aggregation, the trajectory per-request inspector — could only render a permanently zero reasoning figure for pi-ai routes.

## Decision

`mapUsage` in `dsh-llm-pi-ai` now passes `usage.reasoning` through as `reasoningTokens` whenever pi-ai reports the split, including a reported zero, which marks the route as one whose provider exposes the breakdown. Providers without a breakdown leave the field absent, so absence keeps meaning "not recorded" rather than "no thinking". The four billed buckets are untouched: `reasoningTokens` is a sub-breakdown of `outputTokens`, and the token-meter projection continues to accumulate only the disjoint buckets, so no count is double-booked.

No session-log mechanism changes: `assistant/message` already types its payload `usage?: TokenUsage`, the field is optional, and `SESSION_FORMAT_VERSION` stays at 0 because nothing structural changed. Historical logs simply lack the field, and readers must treat that as "not recorded", never as a measured zero.

## Alternatives considered

**Estimate reasoning tokens from stream content.** Rejected because the persisted reasoning block text is post-hoc: redacted or encrypted thinking has no faithful text, and counting characters would fabricate a figure the provider never reported.

**Add a fifth additive usage bucket.** Rejected because providers bill reasoning inside output; adding it again would double-count every thinking token in totals and context-pressure projections.

**Leave the field dropped.** Rejected because the data exists at the adapter boundary for exactly the routes deployments run reasoning-heavy models on, and dropping it makes every downstream reasoning figure a fabrication.

## Verification

The `mapUsage` unit tests pin the pass-through (reported value, reported zero, and absence), including that `outputTokens` does not grow by the split. The adapter integration test over a mock OpenAI-completions endpoint now observes `reasoningTokens: 0` on a plain completion, matching pi-ai's always-present split on that API. The authored `usage-reasoning-split` session snapshot replays a turn whose usage carries the split beside an exact `totalTokens` and proves both persist to the session log and the assembled assistant message.

## Consequences

New sessions on pi-ai routes record real reasoning splits; Anthropic, OpenAI Responses, Google Generative AI, and Google Vertex routes record them when the provider reports them, while OpenAI completions supplies its split including zero. Historical sessions keep no reasoning data, so cross-session readers must distinguish "not recorded" from zero. The per-request trajectory inspector, which already rendered `reasoningTokens` when present, now shows figures for pi-ai routes without further change.

# Agent Note: Canonical request preflight admits compaction before dispatch

Status: implemented

English | [中文](2026-08-25-context-preflight-admission.zh.md)

## Problem

Automatic compaction observed pressure at `agent/pre-step`, before the loop had resolved the request route, adapter defaults, context capacity, system prompt, and tools for the request it was about to send. A route or prompt change could therefore make the assembled request exceed capacity after the pressure check. Recovery then depended on a rejected provider call through `agent/request-error`, which costs latency and cannot protect a summarization replay that is itself too large for its selected model.

The retry mechanism also needs stronger evidence than log growth. Failed compaction brackets and unrelated durable events advance the session log without reducing model history. Accepting those events as retry proof permits non-productive loops, while dropping history to force admission would violate the session log's role as the durable source of model-visible context.

## Decision

The agent loop exposes the `agent/request-preflight` waterfall after it prepares the exact adapter route and appends the canonical `request/header` and `request/context`, but before it derives request messages. The payload carries the frozen canonical header, resolved context capacity when advertised, request coordinates, cancellation signal, and one-based attempt coordinates. Waterfall listeners delegate with `next()`; a listener that commits a replacement surface may return `{ kind: 'retry', surfaceGeneration }` to rerun admission against the durable replacement.

The loop accepts retry only when the returned generation equals the current `session.surface.replaceGeneration` and is newer than the preceding admission pass. Log-only changes and stale generations fail loudly. The loop permits eight productive passes as a fixed hot-loop safety invariant. At the ceiling it admits the complete durable surface instead of truncating it, leaving provider-confirmed overflow and `agent/request-error` recovery reachable.

Compaction-basic owns the first consumer. It resolves policy from the preflight header's exact provider and model, measures the logged envelope and surface, and qualifies either configured pressure or combined request-plus-output capacity. Each admission uses at most `maxOverflowRetries` replacement attempts. Optional tool-result pruning runs only after pressure qualifies; any replacement progress causes redispatch even if later summarization fails.

Before automatic summarization, compaction-basic resolves the actual summarizer model capacity. It constructs the summary target's exact request header, prices replay nodes and the canonical system and tool envelope through that header, reserves the configured summary output cap, prices the trailing compaction instruction, and limits the selected balanced head range to the remaining replay input budget. If the smallest balanced range cannot fit or capacity is unavailable, it makes no summary call and delegates with the full durable request. A completed assistant message ends the current request's admission budget, including when its tool call continues the same turn into another request. The provider overflow listener remains an independent backstop with its own retry sequence.

## Consequences

The first request after a route, prompt, tool, or history change is checked against the same canonical header the provider receives. A successful replacement is remeasured by the complete waterfall before messages are derived, so downstream listeners observe the admitted state. Durable source events remain in the append-only log; compaction changes only the derived surface through an explicit replacement event.

Unknown capacity fails closed for proactive summarization and may still reach a provider that can report canonical overflow. A configured summary output cap larger than the summary model's available window prevents automatic replay rather than issuing a predictably invalid auxiliary request. Deployments that set `maxOverflowRetries: 0` disable both proactive replacement retries and provider-overflow replacement retries while retaining manual compaction.

## Alternatives considered

- **Keep pressure at `agent/pre-step`** — rejected because the check cannot see the exact route, adapter defaults, canonical header, or resolved capacity.
- **Use session event count as retry proof** — rejected because failed brackets and unrelated events do not prove a model-history replacement.
- **Let each plugin own the only retry bound** — rejected because one defective listener could keep the core loop alive indefinitely.
- **Trim derived messages at admission** — rejected because it silently removes durable model-visible history and makes replay, persistence, and provider behavior disagree.
- **Replace provider-overflow recovery** — rejected because adapter capacity metadata can be absent or approximate; the provider-confirmed path remains the authoritative backstop.

## Verification

Focused agent-loop tests cover ordering, frozen headers, authoritative generation proof, redispatch, derivation after replacement, and the core ceiling. Compaction loop tests cover exact-request pressure before dispatch, a public real-loop tool-call continuation with a fresh admission budget, summary-target header pricing, balanced replacement ranges, and preservation of thrown and in-band provider-overflow recovery. Cross-route adapter tests prove image-count caps remain isolated by route. Repository typecheck, lint, bilingual documentation gates, exact runtime coverage, and the focused suites verify the assembled change.

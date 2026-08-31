# Agent Note: Structured subagent provider failure signals

Status: implemented

English | [中文](2026-08-26-structured-subagent-failure-signal.zh.md)

## Problem

A child result previously carried only bounded diagnostic text. A parent could read a provider quota explanation but could not branch reliably without parsing prose, so it could dispatch another child to the same exhausted route.

## Decision

SubagentResult.failure is an optional machine-readable companion to diagnostic. diagnostic remains bounded human/model-readable context; failure carries the LLM seam’s merge-extensible typed failure code and an optional provider-requested retry delay in milliseconds. A present failure names a known code such as `QUOTA` or `RATE_LIMIT`; an absent failure means no classified cause reached the seam. The Codex provider maps typed provider facts from its app-server wire and retains subprocess outcome facts in its bounded diagnostic; the generic dsh-sdk, ACP, and Claude Code transports do not currently produce `SubagentResult.failure`. `SubagentFinishedNotification` does not carry failure; neither the TypeScript nor Python SDK notification is extended.

Unknown or unclassified errors do not synthesize a failure. Consumers must use a default branch and treat future unrecognised codes as non-retryable.

The subagent-level closed cause taxonomy was considered and rejected: the subagent seam already depends on dsh-llm, and reusing its typed failure-code vocabulary avoids duplicate public classifications while preserving non-LLM failures as absent signals.

## Alternatives considered

**Parse diagnostic text.** Rejected because wording is not a stable branch key and would recreate repeated quota retries.

**Create a separate subagent cause union.** Rejected because the seam already depends on dsh-llm and its typed failure-code vocabulary is sufficient evidence-backed routing data; a second taxonomy would duplicate public choices.

**Add an unknown member or synthesize a code.** Rejected because an absent optional failure already means no classified cause reached the seam. Guessing would make an orchestrator retry an error that cannot succeed.

This note partially supersedes the deferred classification discussion in [background settlement diagnostics](../bug-fix/2026-08-25-background-settlement-diagnostic.md), which remains authoritative for bounded readable diagnostics.

## Consequences

One-shot local results and applicable background settlement notices carry the signal. The parent-facing notice says the provider quota is exhausted or is temporarily rate-limiting the route, and includes retry-after seconds only when known; it never exposes transport vocabulary, credentials, or raw provider payloads. The existing teardown diagnostic remains unchanged and is still bounded. SDK `SubagentFinishedNotification` payloads do not carry failure; neither the TypeScript nor Python SDK notification is extended.

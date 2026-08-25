# Agent Note: Structured subagent provider failure signals

Status: implemented

English | [中文](2026-08-26-structured-subagent-failure-signal.zh.md)

## Problem

A child result previously carried only bounded diagnostic text. A parent could read a provider quota explanation but could not branch reliably without parsing prose, so it could dispatch another child to the same exhausted route.

## Decision

SubagentResult.failure is an optional machine-readable companion to diagnostic. diagnostic remains bounded human/model-readable context; failure carries a closed provider-neutral cause union (quota, rate-limit, transient, or permanent) and an optional provider-requested retry delay in milliseconds. A present failure always names a known cause. An absent failure means the run did not fail or no cause was learned.

Unknown or unclassified errors do not synthesize a cause. Consumers must treat future unrecognised union members as non-retryable by default.

The mapping helper consumes existing structured LlmFailure facts, but the subagent seam owns its own taxonomy. Importing the LLM failure-code type was considered and rejected: subagent providers can be non-LLM processes, and making SubagentResult depend on an LLM-specific taxonomy would let one consumer dictate the capability seam.

## Alternatives considered

**Parse diagnostic text.** Rejected because wording is not a stable branch key and would recreate repeated quota retries.

**Use the LLM failure-code type in SubagentResult.** Rejected because the subagent seam also serves crashes, teardown failures, and non-LLM providers. The seam maps known LLM facts into its provider-neutral cause union instead.

**Add an unknown union member.** Rejected because it overlaps with an absent optional failure. Absence unambiguously means no known cause; present values are classifications.

This note partially supersedes the deferred classification discussion in [background settlement diagnostics](../bug-fix/2026-08-25-background-settlement-diagnostic.md), which remains authoritative for bounded readable diagnostics.

## Consequences

One-shot and background integration points can stop dispatching on quota, wait using retry-after, or reroute on known transient failures without exposing credentials or raw provider payloads. The protected lifecycle integrations remain separate from this contract change.

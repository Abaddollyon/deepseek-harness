# Agent Note: Subscription web-search provider contract

Status: proposed

English | [中文](2026-09-02-subscription-web-search-provider-contract.zh.md)

## Problem
Subscription CLIs need web search without host wiring or credential reads.

## Proposal
Each provider is an independent Cordis plugin registering through `ctx.web.registerSearchProvider`, with a fixed ID and one managed process per request.

## Alternatives considered
Host wiring, fallback chains, shared processes, and credential inspection were rejected.

## Acceptance criteria
Codex speaks the narrow app-server protocol, normalizes WebSearchResult, classifies errors, and cleans up process trees.

## Risks
CLI protocol drift may require replay updates; auth errors must remain actionable without exposing secrets.
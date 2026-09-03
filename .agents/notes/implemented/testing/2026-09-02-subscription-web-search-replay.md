# Agent Note: Subscription web-search replay

Status: implemented

English | [中文](2026-09-02-subscription-web-search-replay.zh.md)

## Problem

Codex and Claude Code web search depend on authenticated local CLIs. Browser and ACP coverage must exercise their real provider code without reading credentials, contacting the network, or permitting a missing CLI to hang a turn.

## Decision

The Codex fixture is a deterministic stdio app-server that replays the package's JSON-RPC lifecycle. The Claude Code fixture is a scripted Agent SDK query that invokes the provider's managed-process callback before yielding one raw WebSearch message and one structured result. The Web scaffold selects `codex` or `claude-code` only through a test-owned profile patch and registers the real provider after the shipped tree settles; the product bundle remains unchanged.

## Alternatives considered

Using live CLIs or provider credentials would make the suite nondeterministic and violate keyless replay requirements; adding provider rows to the product bundle would test the wrong composition boundary.

## Consequences

Success assertions cover answer text, normalized sources, truncation metadata, the WebSearchResultView card, and zero surviving managed children. Separate keyless rounds make executable resolution fail locally and assert the actionable `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` tool error within a bounded timeout. ACP-owned expected snapshots reuse the same provider fixtures and contain no credentials, network data, or machine paths. Source dates are fixed synthetic values (2001-01-01T00:00:00Z through 2001-01-06T00:00:00Z), never current timestamps.

## Testing

Run `pnpm run test:web:refresh -- apps/web/tests/web-search-round.e2e.ts` for browser ARIA goldens and `pnpm run test:expected:refresh -- apps/cli/tests/profiles/acp/tests/subscription-search.expected.e2e.ts` for ACP fixture snapshots; replay remains the normal keyless mode.

# Agent Note: Publish Claude Code adapter helpers

Status: implemented

English | [中文](2026-09-02-claude-code-adapter-public-exports.zh.md)

## Problem

The Claude Code subagent package already owned the official Agent SDK option projection and the conversion from an SDK spawn request into a Harness-managed `ctx.subprocess` process tree. The Claude Code web-search provider needed those same boundaries. Importing package-private source paths would make its published package layout unstable, while copying the process adapter would create two cleanup and environment policies for the same CLI.

## Decision

`@deepseek-ai/dsh-subagent-claude-code` exposes four adapter symbols from its package root:

- `claudeSpawnSpec` converts an Agent SDK spawn request into the complete managed subprocess specification.
- `ManagedClaudeCodeProcess` projects a `SubprocessHandle` back into the process interface expected by the Agent SDK.
- `sdkEnvironmentOverlay` builds the explicit SDK child environment overlay without bypassing subprocess credential scrubbing.
- `claudeQueryOptions` builds the shared non-interactive Agent SDK query options.

These are public integration seams, not a second provider API. The web-search package imports the process projection from the package root and retains ownership of its search-only tool policy, structured output schema, timeout, error taxonomy, and request lifecycle. A root re-export test keeps the public entrypoint identity-equal to the implementation symbols.

## Alternatives considered

**Copy the adapter into the web-search package** was rejected because fixes to environment scrubbing, stdio projection, exit mapping, or process-tree cleanup could diverge between Claude features.

**Import `src/process.ts` and `src/run.ts` directly** was rejected because source subpaths are implementation details and are not a durable published-package contract.

**Move the helpers into a new Claude SDK utility package** was rejected because the subagent adapter remains their implementation owner and one additional package would add dependency and release surface without separating a distinct policy.

## Consequences

Claude-backed features share one tested SDK/subprocess boundary, and consumers can depend on stable package-root exports instead of source layout. The exported names and semantics now require compatibility review when the subagent implementation changes. Search-specific policy remains outside the shared adapter, preventing a reusable process helper from becoming a hidden coordinator or fallback chain.

# Agent Note: Wire-facing agent types live in the pure-type outlet

Status: implemented

English | [中文](2026-08-20-pure-type-outlet-for-wire-facing-agent-types.zh.md)

## Problem

`AgentActivity` — the live qualifier a session-status frame carries — was declared in `dsh-agent/runtime-types.ts`, the module that also declares the `Agent` interface and the `Events` declaration merging for every agent-subject event.

The client aggregate then failed to typecheck. A client package needs the *value union* to render a stopping affordance, but importing it from the runtime module drags the host `Context` merge into a client program — and the repository's compiler layout exists precisely to keep the host and client cordis `Context` merges from ever meeting in one `ts.Program`. The type was correct; its address was not.

## Decision

`AgentActivity` is declared in `packages/core/agent/src/types.ts`, the package's pure-type module (`src/types.ts` contains only types — no runtime code), and is re-exported from `runtime-types.ts` so every existing host importer is unchanged. The package already publishes that module as its own `./types` export condition, so a client package imports the union through an outlet that carries no service declaration, no `Events` merge, and no `Context` augmentation.

## Alternatives considered

**Duplicate the union in a client package.** Rejected: two declarations of one wire vocabulary drift the first time a value is added, and the host would have no compile-time signal that the client's copy no longer matches what it sends.

**Re-export from the client-side package that renders it.** Rejected: the re-export chain would still resolve through the host module, so the merge would still land in the client program — the failure mode this change exists to remove.

**Widen the frame's field to `string` at the wire boundary.** Rejected: the field is a closed vocabulary the host owns, and erasing it to `string` moves an exhaustiveness check the compiler was performing into a runtime branch nobody writes.

## Consequences

A type that crosses the host/client wire belongs in the pure-type outlet, not beside the service that produces it — this is the general rule the change instantiates, and the next wire-facing vocabulary should be declared there directly. Host importers are unaffected: `runtime-types.ts` re-exports the union, so `import type { AgentActivity } from '@deepseek-ai/dsh-agent'` still resolves. The split costs one re-export line and removes a whole class of aggregate-typecheck failures that only appear when a client package finally consumes the vocabulary.

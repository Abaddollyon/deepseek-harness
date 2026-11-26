---
kind: upgrade-guide
description: "A Session's additional workspace roots become per-Agent writable-root grants: resolve() reports them only while an Agent runs on the Session, and the policy text lists them only in workspace-write mode."
---

# Additional workspace roots are granted per Agent

English | [中文](guide.zh.md)

## Change

A multi-root Session still records its additional directories as the seq-0 `workspace/roots` event, and Workspaces still pass `additionalPaths` to new Sessions. Enforcement changes.

In the previous fork release, `ctx.sandboxPolicy.resolve({ session })` read `session.additionalPaths` on every call and returned them first in `additionalWritableRoots`, then the configured extra directories. The model-visible policy text listed "Workspace roots for this session" in every mode.

Now `SandboxPolicyService` registers each recorded root with `registerWritableRoot` when `agent/created` announces an Agent on the Session, for that Agent's lifetime, and on every start: startup, resume, clear, and compact. `resolve()` reports the configured extra directories, then the registered roots. A Session with no live Agent receives no grant. A root that is no longer a directory in the Agent's execution world, or cannot be inspected, is skipped with a `sandbox-policy` warning instead of failing every write. The policy text lists the roots as "Additional writable directories" in workspace-write mode only; read-only and danger-full-access text no longer names them. On Windows these grants apply to file tools, not sandboxed processes.

Affected: code that calls `resolve()` for a Session without a live Agent, code that depends on the order of `additionalWritableRoots`, and recorded-session snapshots of multi-root policy text. `CreateSessionOptions.meta` is now typed `SessionCreationMeta`, which adds `additionalPaths` to `SessionHeaderMeta`; existing creation calls compile unchanged.

## Migration

1. Resolve the policy for a multi-root Session only after its Agent is created, for example inside an `agent/created` listener (the sandbox policy prepends its own) or from a tool call of the running Agent. To grant a directory without an Agent, call `ctx.sandboxPolicy.registerWritableRoot(session, directory)` and call the returned disposer when the grant ends.
2. Compare `additionalWritableRoots` as a set, not by position.
3. Re-create a recorded root that was removed, or start a Session without it; the warning names the Session and the skipped path.
4. Re-record snapshots whose system prompt contains the multi-root policy text.
5. Confirm the migration: resume a multi-root Session in workspace-write mode, write a file under one additional root, and check that the policy text lists that root.

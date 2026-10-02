# Agent Note: Narrower sandbox requests run confined without approval

Status: implemented

English | [中文](2026-10-02-sandbox-narrower-mode.zh.md)

## Problem

A delegated agent can ask for `sandbox_permissions: workspace-write` while its Session runs `danger-full-access`. Rejecting that call stops the work, although the request asks for less access than the call already holds.

## Decision

`approveEscalation` returns a strictly narrower requested mode without approval, and the tool runs that one call confined at the narrower mode. Repeated modes still return the effective mode, wider modes still require approval, and unsupported targets still fail before execution. Argument pairing remains mandatory at the tool. This partially supersedes the narrower-target rejection in the [same-mode decision](2026-09-16-sandbox-same-mode.md) and the [sandbox decision](2026-07-06-sandbox.md); their confinement and per-call approval decisions remain active.

## Alternatives considered

**Reject narrower requests.** A request that reduces access cannot raise risk, so failing it only blocks authorized work.

**Ignore the request and run at the effective mode.** The call would run with more access than the model asked for, and the result would not match the request.

**Carry a narrowed `run_code` mode into its nested calls as a ceiling.** Nested bash, PowerShell, filesystem, terminal and plugin-manager calls each resolve their policy from the Session, so a ceiling would have to reach every one of those resolution points through the `exec.parent` chain. That is too wide a change for this fix, so `run_code` refuses a narrower mode instead (see Consequences).

## Consequences

Bash, PowerShell and filesystem calls run confined at a requested narrower mode without an approval service or agent. `run_code` refuses a narrower mode before asking or running: it would confine only the program process, while the program's nested tool calls keep the Session's wider mode and the result would report a confinement they did not have. The model narrows a nested call by passing `sandbox_permissions` on that call. The shared unit tests cover each narrower pair, and the bash and PowerShell tests check that the executor receives the narrower mode without a prompt.

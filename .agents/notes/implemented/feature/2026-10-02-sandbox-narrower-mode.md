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

## Consequences

Bash, PowerShell, filesystem, and `run_code` calls run confined at a requested narrower mode without an approval service or agent. The shared unit tests cover each narrower pair, and the bash and PowerShell tests check that the executor receives the narrower mode without a prompt.

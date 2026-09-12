# Agent Note: Isolated Node compatibility jobs on self-hosted Linux

Status: implemented

English | [中文](2026-09-06-node-compatibility-selfhosted.zh.md)

## Problem

The original private-repository optimization moved Node 22.19, 24.9, and 26 compatibility jobs to an already selected private Linux pool to reduce hosted minutes. Version installers on a persistent shared machine need isolation to avoid tool-directory collisions and generated caches outside runner cleanup.

## Decision

The original decision selected private Linux capacity for non-Dependabot, same-repository, non-fork pull requests and isolated each runtime installation. The [public hosted CI decision](2026-09-10-public-hosted-ci.md) supersedes that runner selection: all three [CI](../../../../.github/workflows/ci.yml) matrix entries use `ubuntu-latest` regardless of failover variables or PR origin. Hosted setup uses version-specific `actions/setup-node`, pnpm caching, and the existing runner-private pnpm setup destination. Private-runner preload, cache isolation, and executable-path checks are absent from the PR workflow.

The retained [ESM preload](../../../../scripts/ci-compatible-toolcache.mjs) records the original isolation mechanism but has no active PR workflow consumer. The Actions runner overwrites reserved environment variables after reading step configuration, so the preload assigns a temporary tool cache inside the setup action process. The original setup kept compile caches and node-gyp headers under runner cleanup, retained the shared content-addressed pnpm store, and checked the installed executable's path. This traded repeated Node downloads for isolation across concurrent runners and versions without mutating global Node symlinks or system packages. Any reuse requires fresh wiring and isolation evidence; the historical checks do not authorize private PR execution.

The [failover runbook](2026-07-26-ci-failover-runbook.md) owns remaining release rehearsal routing and private standby opt-in. The [serial reference decision](2026-07-21-serial-cross-platform-ci-reference.md) records complete master aggregates. Their remaining responsibilities are independent of the hosted-only compatibility matrix. The alternatives below preserve the original optimization's rationale rather than reopening PR failover.

## Alternatives considered

**Keep all compatibility jobs hosted.** This avoids extra shared-host load but continues paying for Linux runtime checks that do not require a different operating system or architecture.

**Use the shared Node installation or global version-manager links.** The jobs must run different Node releases concurrently. Mutable shared links would make the selected version depend on another job's timing.

**Move the Python SDK job in the same change.** Its setup-python installation and global pip installation of uv need separate isolation evidence. Its short hosted job is not required for the Node optimization.

## Consequences

Compatibility checks consume hosted capacity rather than adding three jobs to the shared private VM. Each retains gate concurrency one, including the build-backed Node 22 leg, the same version names, and the same compatibility and loader checks. Hosted pnpm caching remains enabled. The original September 6 inventory of 31 Linux registrations counted runner instances, not independent machines; shared-host contention remains relevant only to remaining private workloads. Master scheduling is unchanged by the compatibility matrix.

## Verification

The focused [workflow regression](../../../../scripts/ci-compatible-selfhosted.spec.ts) pins hosted routing across authors, repository origins, and failover values, all version entries, hosted cache setup, and absence of private-runner setup. It independently exercises the retained preload; the broader [workflow spec](../../../../scripts/ci-workflow.spec.ts) checks every direct PR runner label and the required verdict. The historical runs below establish the original private installation's behavior, not current PR routing or a guarantee of private pool capacity.

[Successful standby run 33984559660](https://github.com/deepseek-harness/deepseek-harness/actions/runs/33984559660) at the implementation base supplies Linux Node 24.19.0 and Windows Node 24.20.0 baseline evidence. Linux job 101359402557 uses runner-specific temporary and tool directories on the data volume. [Read-only capability probe 34012679056](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012679056/job/101431064925) reports Linux x64, 192 online logical CPUs, GCC/G++ 13.3, Make 4.3, and Python 3.12.3. Python 3.10 is absent, reinforcing the separate SDK provisioning requirement. [PR run 34013779750](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34013779750) at `282519d2` verifies Node 22.19.0, 24.9.0, and 26.8.1 on self-hosted Linux, including setup, executable-path checks, compatibility tests, and post actions. The executables reside under each runner’s `_temp/node-compat-toolcache/node/<version>/x64/bin`; the completed jobs take 228s, 94s, and 101s respectively. These observations establish version and path compatibility, not an exclusive-host capacity guarantee.

# Agent Note: Public pull-request CI uses hosted runners

Status: implemented

English | [中文](2026-09-10-public-hosted-ci.zh.md)

## Problem

Pull-request merge refs can carry contributor-controlled workflow changes. Workflow expressions that select private runners do not establish a security boundary, and unavailable private capacity can strand the required verdict. Standard hosted runners also have less capacity than the larger pools for which the concurrent CI workloads were sized.

## Decision

[Pull-request CI](../../../../.github/workflows/ci.yml) uses only standard GitHub-hosted runners, including the Node compatibility matrix and the required verdict. The benchmark retains its pinned hosted image, and the reusable Python runtime builder retains its hosted platform matrix. Failover variables do not select pull-request runners. This decision supersedes the main-CI pull-request routing in the [failover runbook](2026-07-26-ci-failover-runbook.md) and the private-pool selection in the [Node compatibility decision](2026-09-06-node-compatibility-selfhosted.md); release rehearsal workflows remain outside this change.

Administrators must exclude public repositories from private runner-group access. A contributor can change a pull-request workflow, so neither the hosted labels nor a repository predicate in that workflow substitutes for the runner service's access policy.

[Master CI](../../../../.github/workflows/ci-master.yml) retains both complete unsharded private standby aggregates. They run only on master pushes in a private repository whose `DSH_CI_PRIVATE_RUNNER_REPOSITORY` variable equals its full `github.repository` name. An unset or mismatched variable skips them before runner allocation. This is an explicit scheduling opt-in, not runner authorization. Hosted master platform checks and the separately scoped [fork master gate](../../../../.github/workflows/ci-fork-master.yml) remain available without that opt-in.

Hosted gate and nested browser, snapshot, lint, and package-validation concurrency are bounded together. Coverage uses two instrumented partition processes beside one exempt-heavy worker; reducing only `DSH_COVERAGE_MAX_WORKERS` would leave the partition count unchanged. Inventory, thresholds, test deadlines, and required verdict dependencies remain unchanged. Cache restoration and browser system-dependency installation follow `runner.environment`, not failover variables. Restore-only package and browser caches retain their existing cold-start limitation.

## Alternatives considered

**Select private runners for trusted pull requests in YAML.** Rejected because contributor-controlled workflow expressions cannot establish trust. Private PR failover requires a separately enforced access policy and is not provided by this workflow.

**Remove the master standbys.** Rejected because their complete serial aggregates provide readiness evidence for independently operated private pools. Explicit private-repository opt-in preserves that evidence without queueing public repositories on unavailable pools.

**Keep larger-runner concurrency or weaken coverage.** Rejected because excess simultaneous processes compete for standard hosted CPU and memory, while reduced inventory or thresholds would remove verification rather than bound its resource use.

## Consequences

Pull-request checks no longer depend on private pool availability, but a hosted outage cannot be bypassed with the main-CI failover variables. Conservative concurrency may increase elapsed time; hosted CI remains responsible for validating the complete workloads on its actual resources. Private operators must opt in and maintain runner-group access restrictions outside these workflow files.

The [workflow spec](../../../../scripts/ci-workflow.spec.ts) checks all direct PR runner labels and Node matrix labels, actual-runner cache and browser predicates, fixed hosted budgets, required verdict inputs, and private standby event, visibility, and opt-in cases. These configuration checks do not prove live runner permissions or workload performance.

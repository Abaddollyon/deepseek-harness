# Agent Note: Run fork master CI on hosted infrastructure

Status: implemented

English | [中文](2026-08-30-fork-master-hosted-ci.zh.md)

## Problem

The fork master branch needs a blocking signal when changes land, but the upstream master workflow delegates its push jobs to private self-hosted pools and the upstream pull-request workflow delegates its static and coverage lanes to private enterprise pools. A fork cannot allocate either pool, so neither workflow executes a code gate on the fork; the only hosted job in the upstream master workflow is the Wine cache seeder.

A supersession check found no existing Agent Note for fork-specific master CI.

## Decision

The separate ci-fork-master.yml workflow runs one Ubuntu-hosted job on master pushes, on pull requests targeting master, and on manual dispatches. The job runs pnpm run check:ci:static followed by pnpm test. The static command remains owned by scripts/run-gates.ts, so its build-backed checks cannot drift into a parallel definition. The archived-note seal gate receives the trusted pre-change commit for each event: the pull-request base, the pre-push commit, or the dispatched HEAD.

The upstream ci-master.yml and ci.yml remain unchanged: their self-hosted and enterprise jobs belong to the upstream repository and remain available for environments that provide those pools. A job-level guard limits the workflow to the fork repository (github.repository == 'Abaddollyon/deepseek-harness'), so the file reports skipped instead of consuming minutes wherever it travels with the repository, and the same guard pins manual dispatch to master so it cannot target an arbitrary ref. The workflow-policy spec pins that guard exactly and pins the gate as hosted-only, keyless, read-only, and scoped to the fork mainline. Keyless is a boundary-token policy: the spec scans the parsed workflow for the secrets context as a case-insensitive word token, so dotted, bracketed, whitespace-padded, and whole-context spellings such as toJson(secrets) all reject, while identifiers that only contain the substring stay admitted.

## Alternatives considered

**Modify ci-master.yml to replace its runners.** Rejected because that would delete upstream self-hosted validation and create a permanent fork/upstream merge conflict.

**Copy the full upstream matrix onto hosted runners.** Rejected because it would launch nine jobs on every push and exceed the fork affordable gate budget.

**Rely on the upstream pull-request workflow for fork PRs.** Rejected because its static and coverage jobs name upstream enterprise runner labels that never allocate in the fork.

## Consequences

The fork gets an actually executing hosted static/unit signal on master pushes and master-bound pull requests, at the cost of not running upstream coverage, platform matrix, or native runner checks on those events. Manual dispatch remains available for verification.

## Verification

The workflow-policy spec, Agent Note format and classification gates, and the translation-pairing gate pass locally. The first hosted run on fork master is recorded by the integrating change once this workflow reaches the fork default branch.

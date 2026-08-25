# Agent Note: Run fork master CI on hosted infrastructure

Status: implemented

English | [中文](2026-08-25-fork-master-hosted-ci.zh.md)

## Problem

The fork master branch needs a blocking signal when changes are pushed directly, but the upstream master workflow delegates its push jobs to private self-hosted pools. The existing pull-request workflow cannot provide that signal because it listens only to pull requests.

A supersession check found no existing Agent Note for fork-specific master CI.

## Decision

The separate ci-fork-master.yml workflow runs one Ubuntu-hosted job on master pushes and manual dispatches. The job runs pnpm run check:ci:static followed by pnpm test. The static command remains owned by scripts/run-gates.ts, so its build-backed checks cannot drift into a parallel definition.

The upstream ci-master.yml remains unchanged: its self-hosted jobs belong to the upstream repository and remain available for environments that provide those pools.

## Alternatives considered

**Modify ci-master.yml to replace its runners.** Rejected because that would delete upstream self-hosted validation and create a permanent fork/upstream merge conflict.

**Copy the full upstream matrix onto hosted runners.** Rejected because it would launch nine jobs on every push and exceed the fork affordable gate budget.

## Consequences

The fork gets an actually executing hosted static/unit signal, at the cost of not running upstream coverage, platform matrix, or native runner checks on each master push. Manual dispatch remains available for verification.

## Verification

The branch workflow was dispatched through GitHub Actions; the run URL and conclusion are recorded with the implementation.

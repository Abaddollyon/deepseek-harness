# Core Coverage Session Report

## Scope

Coverage-only regression work in the isolated lane. No extension files, live runtime, or owning server were touched.

## Changes

- Added malformed workspace/roots seed validation coverage and honest duplicate-root continuity regressions.
- Removed unreachable workspaceRootsCount bookkeeping/duplicate guard from packages/core/session/src/index.ts; contiguous sequence validation plus the required sequence-0 workspace-root invariant already reject duplicate roots.
- Added workspace additional-root propagation tests for session creation and fork inheritance.
- Added missing-root workspace conflict mapping coverage.
- Added child-agent metadata inheritance coverage.
- Added a JSONL public stat() regression covering newest opposite-compression generation selection.

## Verification

- Focused Vitest: exit 0, 5 files / 297 tests passed.
  - packages/core/session/tests/session.spec.ts — 79
  - packages/session/session-persistence-jsonl/tests/jsonl.spec.ts — 178
  - packages/api/session-controller/tests/agent.host.spec.ts — 18
  - packages/api/session-controller/tests/commands-create-fork.host.spec.ts — 17
  - packages/subagent/subagent/tests/child-agent.spec.ts — 5
- Native JSONL prerequisite: exit 0, pnpm run build:native-system.
- TypeScript: exit 0, pnpm exec tsc -p tsconfig.json --noEmit.
- Owned-file lint and diff checks: exit 0 (one pre-existing unused suppression warning in core/session/src/index.ts).

## Full partitioned coverage

DSH_COVERAGE_PARTITIONS=2 DSH_COVERAGE_MAX_WORKERS=3 pnpm run test:coverage:partitioned ran 1,209 files / 21,576 passed tests and exited 1. The owned targets were closed except packages/core/session/src/index.ts:296, an unreachable false branch in validateWorkspaceRoots (all call sites pass workspace/roots events). The same run reported 41 uncovered locations in unrelated workspace/test-support files; these are outside this lane ownership. Full output: /home/arro/coding/dsh-integration-20260920/artifacts/core-coverage-session-r2.log.

The focused command built-in per-file 100% threshold is not meaningful when only the five regression files are selected, because it excludes the rest of the source-owning test suite; no threshold or exclusion was changed.

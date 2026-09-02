# Agent Note: Alpha 5 integrated-tree re-baseline

Status: implemented

English | [中文](2026-09-02-alpha5-rebaseline.zh.md)

## Problem

A one-time re-baseline must make the integrated tree's lineage, seam choices, dropped work, and keyless verification evidence reproducible without relying on an external disposition ledger.

## Decision

The integrated re-baseline uses upstream tag dsh-v0.1.2-alpha.5 as its base and records the completed 22-lane, 126-carry reconciliation: 92 dispositions retained, 18 adapted, and 16 dropped. The one-time full regeneration and keyless local gates are the release evidence for the integrated tree.

The adopted seams are SessionSeq/SessionLogOffset for ordered session state, Deque ControlQueue for serialized control, ActivationObserver for lifecycle activation, settings injection for configuration, hostInfo/UiWorkspace for host/client workspace boundaries, and durable Jobs on the storage domain.

Carries are dropped when their behavior was already re-landed through a newer seam, depended on unavailable model credentials, duplicated generated output, or represented superseded architecture. The remaining final coverage carry covers only candidate paths still uncovered on the integrated tree; hosted-runner flakes remain known and are not weakened: agent-team persistence.spec.ts:215, inspector integration.host.spec.ts:381, session-snapshot harness waitFor, and terminal-bash local.spec.ts:331.

## Alternatives considered

**Re-record every golden.** Model credentials are intentionally unavailable, so model-dependent outputs remain unchanged and are not guessed. **Keep the external ledger as the only record.** The repository note preserves the disposition summary where maintainers can review it.

## Verification

Generators were run once across the integrated tree. Keyless expected, snapshot replay, packed-session migration/layout, static, documentation, build, lint, unit, GUI, and web replay gates are reported in the reconciliation PR; no model-dependent golden was re-recorded.

## Consequences

The disposition summary is preserved here rather than depending on the external REBASELINE-R1-DISPOSITIONS.json path. Future changes must preserve the adopted seams and explain any new carry or golden refresh.

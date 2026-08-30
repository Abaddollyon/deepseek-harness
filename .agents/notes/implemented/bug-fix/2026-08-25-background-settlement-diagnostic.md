# Agent Note: Background settlement notices name the failure

Status: implemented

English | [中文](2026-08-25-background-settlement-diagnostic.zh.md)

## Problem

A background subagent that failed told its parent only `Background subagent <id> failed before it finished.` The reason existed and was discarded: `ActivationTerminal` carried `stopReason` and `output` but had no member for a failure, so `terminal(failure)` in `lifecycle.ts` mapped every teardown failure to a bare `{ stopReason: 'error' }` and dropped the thrown value on the floor.

The one-shot tool path does not lose it — `stopReasonError` is joined with `SubagentResult.diagnostic` and the child's partial text by `withDiagnosticAndPartialText`. Only the background delivery path was blind, which is the asymmetry the package conventions warn about.

The cost is misattribution, and it is not hypothetical. When a provider route reached its quota, six consecutive background children died with that one sentence. The parent had no way to distinguish an exhausted quota from a crashed scope from a killed process, so it diagnosed host memory, then agent context limits, and re-dispatched onto the same unavailable route four more times. Every one of those retries was avoidable: the underlying error already said what was wrong.

## Decision

`ActivationTerminal` gains an optional `diagnostic`, populated only on the teardown-failure edge, and `settlementSummary` appends it to the `error` sentence as ` Reason: <text>`. The text is the failure's own `String(failure)`, bounded to 4096 UTF-8 bytes — the same ceiling `SubagentResult.diagnostic` documents, and the same detail the one-shot path already reports through `detail: String(error)`.

The reason is attached only where the child cannot speak for itself. An epoch that ended through its own turn keeps reporting `captured`, whose `stopReason` is derived from the child's own events; those endings are already visible to the parent in the child's output and need no synthesized explanation.

## Alternatives considered

**Classify the failure into a code — quota, transport, crash.** Rejected for now: the errors already arrive with contextual text (`SubagentError: subagent "<id>" activation handle disposal failed: ...`), and a classification layer would need a taxonomy per provider while discarding detail no enum can carry. A code is worth adding when a consumer wants to branch on it rather than read it.

**Include the failure's stack.** Rejected: the parent is a model deciding whether to retry or re-route, and a stack is transport-level noise for that decision while raising the chance of carrying environment paths into a notice.

**Report the raw thrown value unbounded.** Rejected: the diagnostic contract states a 4096-byte ceiling precisely because a provider payload can be arbitrarily large, and a notice enters the parent's context window.

## Verification

`packages/subagent/subagent/tests/continuation.spec.ts` — 'withholds an outcome the harness could not durably release' injects a disposal failure and now asserts the parent's notice carries `Reason: SubagentError: subagent "<id>" activation handle disposal failed: scope unwind failed`. That test previously pinned the loss as correct behaviour; it was changed with the behaviour it describes. Endings that come from the child's own turn keep their existing text, which the surrounding cases still assert.

## Consequences

A parent orchestrating background children can now tell why one ended and act on it — stop re-dispatching onto an exhausted route, fall back to another provider, or surface the quota to a human — instead of inferring a cause from silence. The notice grows by one bounded sentence, and only on the failure edge.

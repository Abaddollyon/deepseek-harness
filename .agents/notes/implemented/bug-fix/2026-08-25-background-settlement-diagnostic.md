# Agent Note: Background settlement notices name the failure

Status: implemented

English | [中文](2026-08-25-background-settlement-diagnostic.zh.md)

## Problem

A background subagent that failed told its parent only `Background subagent <id> failed before it finished.` Raw teardown diagnostics existed but were not relayed: `ActivationTerminal` carried `stopReason` and `output` but had no member for a failure, so `terminal(failure)` in `lifecycle.ts` mapped every teardown failure to a bare `{ stopReason: 'error' }` and dropped the thrown value on the floor. Captured known LLM errors carry typed `QUOTA` or `RATE_LIMIT` facts; captured errors that remain unclassified may have no typed failure.

The one-shot tool path does not lose it — `stopReasonError` is joined with `SubagentResult.diagnostic` and the child's partial text by `withDiagnosticAndPartialText`. Only the background delivery path was blind, which is the asymmetry the package conventions warn about.

The cost is misattribution, and it is not hypothetical. When a provider route reached its quota, six consecutive background children died with that one sentence. The parent had no way to distinguish an exhausted quota from a crashed scope from a killed process, so it diagnosed host memory, then agent context limits, and re-dispatched onto the same unavailable route four more times. Every one of those retries was avoidable: the underlying error already said what was wrong.

## Decision

`ActivationTerminal` gains an optional `diagnostic`, populated only on the teardown-failure edge, and `settlementSummary` appends it to the `error` sentence as ` Reason: <text>`. The text is the failure's own `String(failure)`, bounded to 4096 UTF-8 bytes — the same ceiling `SubagentResult.diagnostic` documents, and the same detail the one-shot path already reports through `detail: String(error)`.

The reason is attached only where the child cannot speak for itself. An epoch that ended through its own turn keeps reporting `captured`, whose `stopReason` is derived from the child's own events; those endings are already visible to the parent in the child's output and need no synthesized explanation.

## Alternatives considered

**Classify every failure into a code — quota, transport, crash.** Rejected: only known LLM causes are classified as `QUOTA` or `RATE_LIMIT`; raw teardown diagnostics remain readable text, and unclassified captured errors may have no typed failure. A broader taxonomy would need provider-specific categories and would make consumers branch on guesses.

**Include the failure's stack.** Rejected: the parent is a model deciding whether to retry or re-route, and a stack is transport-level noise for that decision while raising the chance of carrying environment paths into a notice.

**Report the raw thrown value unbounded.** Rejected: the diagnostic contract states a 4096-byte ceiling precisely because a provider payload can be arbitrarily large, and a notice enters the parent's context window.

## Verification

`packages/subagent/subagent/tests/continuation.spec.ts` — 'withholds an outcome the harness could not durably release' injects a disposal failure and asserts that the parent's notice carries `Reason: SubagentError: subagent "<id>" activation handle disposal failed: scope unwind failed`. Surrounding cases assert that endings from the child's own turn keep their existing text.

## Consequences

A parent orchestrating background children can read raw teardown diagnostics and, when a captured LLM cause is known, branch on `QUOTA` or `RATE_LIMIT` — stopping re-dispatch onto an exhausted route, falling back to another provider, or surfacing the quota to a human. A captured error that is not classified has no typed failure. The notice grows by one bounded sentence, and only on the failure edge.

# Agent Note: Background settlement notices name the failure

Status: implemented

English | [中文](2026-08-25-background-settlement-diagnostic.zh.md)

## Problem

A background subagent that failed told its parent only `Background subagent <id> failed before it finished.` Raw teardown diagnostics existed but were not relayed: `ActivationTerminal` carried `stopReason` and `output` but had no member for a failure, so `terminal(failure)` in `lifecycle.ts` mapped every teardown failure to a bare `{ stopReason: 'error' }` and dropped the thrown value on the floor. Captured known LLM errors carry typed `QUOTA` or `RATE_LIMIT` facts; captured errors that remain unclassified may have no typed failure.

The one-shot tool path does not lose it — `stopReasonError` is joined with `SubagentResult.diagnostic` and the child's partial text by `withDiagnosticAndPartialText`. Only the background delivery path was blind, which is the asymmetry the package conventions warn about.

The cost is misattribution, and it is not hypothetical. When a provider route reached its quota, six consecutive background children died with that one sentence. The parent had no way to distinguish an exhausted quota from a crashed scope from a killed process, so it diagnosed host memory, then agent context limits, and re-dispatched onto the same unavailable route four more times. Every one of those retries was avoidable: the underlying error already said what was wrong.

## Decision

`ActivationTerminal` gains an optional `diagnostic`, populated only on the teardown-failure edge, and `settlementSummary` appends the fixed ` Reason: Subagent teardown failed.` sentence. The fixed text identifies infrastructure failure without relaying exception messages, credentials, paths, protocol payloads, or injected instructions into the parent session. Typed failure recovery separately traverses bounded `cause` and `AggregateError.errors` graphs through data descriptors and contains hostile Proxy traps.

The reason is attached only where the child cannot speak for itself. An epoch that ended through its own turn keeps reporting `captured`, whose `stopReason` is derived from the child's own events; those endings are already visible to the parent in the child's output and need no synthesized explanation.

## Alternatives considered

**Classify every failure into a code — quota, transport, crash.** Rejected: only known LLM causes are classified as `QUOTA` or `RATE_LIMIT`; unclassified teardown and captured errors have no typed failure. A broader taxonomy would need provider-specific categories and would make consumers branch on guesses.

**Include the failure's stack.** Rejected: the parent is a model deciding whether to retry or re-route, and a stack is transport-level noise for that decision while raising the chance of carrying environment paths into a notice.

**Report bounded raw exception text.** Rejected: a byte ceiling controls context cost but does not remove credentials, private paths, raw payloads, or prompt-injection text. Infrastructure exceptions remain internal.

## Verification

`packages/subagent/subagent/tests/continuation.spec.ts` injects ordinary and hostile Proxy disposal failures, asserts that parent notices contain only the fixed reason, and proves nested ownership is released so ancestors settle. `failure.spec.ts` exercises cyclic causes, `AggregateError.errors`, descriptor traps, and revoked Proxies while preserving known provider facts.

## Consequences

A parent orchestrating background children can distinguish infrastructure teardown from an ordinary child error without receiving infrastructure exception text. When a known LLM cause survives teardown, it can branch on `QUOTA` or `RATE_LIMIT`; an unclassified error has no typed failure. The notice grows by one fixed sentence only on the teardown-failure edge.

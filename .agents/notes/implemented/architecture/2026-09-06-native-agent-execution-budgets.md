# Agent Note: Native agent execution budgets

Status: implemented

English | [中文](2026-09-06-native-agent-execution-budgets.zh.md)

## Problem

External schedulers stored model-step, input-token, output-token, and retry limits, but the headless runner passed only provider and model to the core Agent. Transporting the numbers without enforcing them would misrepresent scheduled-run isolation.

## Decision

`AgentOptions.budget` carries one complete `{ maxTurns, maxInputTokens, maxOutputTokens, maxRetries }` policy for a live agent-loop instance. The loop admits model steps and request-error retries before the next provider dispatch. It clamps each request's output cap to the remaining total and accounts provider-reported output after every attempt.

Input tokens are a response-accounted continuation threshold. A provider request can cross the threshold because authoritative usage arrives with its response; the loop then refuses the next request. Missing response usage refuses a required continuation with `BUDGET_ACCOUNTING_UNAVAILABLE`. A prepared adapter may supply an exact input-token count to reject an oversized current request before dispatch.

The headless application accepts all four limits together through runner config or `--max-turns`, `--max-input-tokens`, `--max-output-tokens`, and `--max-retries`. Paired `--provider` and `--model` flags select the route for this run without mutating saved settings; an optional `--reasoning-effort` applies an explicit adapter-owned id, while `provider-default` becomes an absent effort. These limits apply to one Agent. A scheduler that launches multiple children owns any shared parent allocation and wall-time deadline.

## Alternatives considered

**Post-hoc output truncation.** Truncating stored text does not limit provider generation, tool execution, or billed output, so the loop caps requests before dispatch instead.

**Require exact input counting from every adapter.** Current providers report authoritative usage after the response but do not all expose their tokenizer. Refusing every bounded run would make the supported scheduler path unusable, so exact preflight counting is optional and response usage governs continuation.

**Treat each child limit as one shared swarm budget.** Independent processes cannot coordinate a total through local counters. The scheduler must divide or reserve a shared budget explicitly if it promises aggregate limits.

## Consequences

Model-step, retry, and requested-output limits stop work before excess dispatch. Input limits can overshoot by one in-flight response and documentation must call them thresholds. Focused fake-adapter tests cover request admission, usage reconciliation, unknown usage, retry denial, CLI validation, and headless Agent forwarding without provider credentials.

The shipped basic compaction backend makes a separate model request outside the conversation loop. Until auxiliary calls share budget accounting, its default model-backed summarizer fails with `BUDGET_ACCOUNTING_UNAVAILABLE` for a budgeted Agent before dispatch. Model-free pruning and subclassed model-independent summarizers remain available; unbudgeted Agents retain normal compaction.

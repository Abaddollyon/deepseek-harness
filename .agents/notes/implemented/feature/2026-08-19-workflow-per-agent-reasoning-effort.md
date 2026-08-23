# Agent Note: Per-Agent Reasoning Effort in Workflows

Status: implemented

English | [中文](2026-08-19-workflow-per-agent-reasoning-effort.zh.md)

## Problem

A workflow script could already point one `agent()` call at any registered provider and any model that provider serves, but not at a reasoning effort. The option was refused by name: `effort` sat in the worker runtime's deferred set beside `isolation` and `agentType`, and the model-facing tool description promised it was "rejected loudly". A draft/verify script therefore had no way to spend a cheap effort on extraction and an expensive one on adversarial review, even though the LLM seam has validated per-call efforts end to end since [adapter-owned reasoning-effort capabilities](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md).

The refusal was not the only gap. `AgentOptions` — the channel a delegation already uses to carry `provider` and `model` to a child — had no effort field, and the loop seeds request config from `provider`, `model`, and `maxTokens` alone. Accepting an effort in the script without closing that gap would have produced the exact accepted-then-ignored failure this repository bans.

## Decision

`agent(prompt, { provider, model, reasoningEffort })` selects the child's complete LLM target, with the three fields independently settable: a call that passes only one keeps the parent agent's values for the other two.

### The name is `reasoningEffort`

Script options are JavaScript identifiers written in one object literal beside `provider` and `model`, so the spelling follows the seam type the option sets — `LlmCallConfig.reasoningEffort` — and not the snake_case a tool-JSON parameter would carry. Claude Code's bare `effort` was rejected as the name: it identifies no dimension, and reusing it would have made a script that meant Claude Code's option silently mean something else. `effort` is consequently no longer *deferred* either; it is simply not a name this engine has, and its rejection now lists the supported set, which names `reasoningEffort`. `isolation` and `agentType` remain deferred and rejected by name.

### Rejection, not substitution, and before the child exists

`LlmRuntime.resolveCallConfig` is the repository's existing policy for an explicit effort: an effort the exact model does not offer is rejected with `UNSUPPORTED_REASONING_EFFORT`, with no clamping or aliasing. Its one substitution materializes an *adapter default* for a caller that requested none, which is a different case and not a downgrade. This change follows that policy rather than inventing a second one.

Validation runs on the host, in `WorkerRun.startChild`, before `SubagentRuntime.start`. The route it validates against is resolved exactly as the subagent seam resolves it — the per-call override if present, otherwise the inherited parent route — so an effort passed alone is checked against what it will really apply to, and an effort passed with `provider`/`model` is checked against the overridden route. A refusal, an incomplete route, or a deployment that composes no LLM capability becomes a fatal `AGENT_START` `WorkflowError`, which the combinators re-throw.

Validating in the host rather than in the child is the point. An effort that reached an unsupporting child would fail that child's turn, and a failed child is exactly what `agent()` reports to the script as `null` — indistinguishable from a model that declined the task. A workflow whose per-call effort could dissolve into a null or, worse, into a quiet downgrade has unpredictable cost and quality.

The capability is read with `ctx.get('llm')`, not injected: the engine needs the LLM service only to validate an effort, and a deployment that never passes one runs unchanged.

### Applying it to the child

The seam declares `AgentOptions.reasoningEffort?: ReasoningEffortId` by module augmentation, the same mechanism `AgentOptions.subagentDepth` already uses, so the effort rides the `agentOptions` channel that carries `provider` and `model` and needs no new `SubagentCapabilities` flag.

Because the loop does not seed an effort from `AgentOptions`, `applyChildComposition` installs it instead, as an Agent-scoped model selection over the child's own resolved route through the `installModelSelection` helper that `bundle/headless` and the API proxy already use for exactly this. That function gained the resolved `AgentOptions` as a fourth parameter for the same reason it takes the parent: it makes composing a child WITHOUT its effort unrepresentable at the call sites, and both in-process composition paths — the one-shot driver and the continuation manager — pass through it. An effort with no complete route to apply to throws inside the creation window, so the start rejects rather than dropping it.

### `meta.phases` carries it too

A phase declaration already annotates the `provider` and `model` its agents are expected to use. Those annotations are informational, and adding a third has no runtime consumer — but provider, model, and effort are now one selectable target, and a declaration carrying two thirds of it would understate the phase's cost while reading as complete. The field is validated and normalized like its two siblings.

## Alternatives considered

- **Seeding the effort from `AgentOptions` in the agent loop.** The structurally cleanest home, and where a top-level agent's effort would belong. Rejected here because it is a change to `packages/core` request assembly with every agent in its blast radius, while the delegation-scoped selection reuses a public helper written for this exact purpose and stays inside the seam that owns child composition.
- **A new `SubagentStartRequest.reasoningEffort` with a matching `SubagentCapabilities` flag.** The seam's documented one-to-one rule between start options and capability flags argues for it, and it would let a backend that cannot honor an effort reject instead of ignoring one. Rejected as disproportionate: a fifth flag forces every provider, test, and capability literal to change, and it would leave the effort inconsistent with `provider`/`model`, which ride `agentOptions` under no flag at all.
- **Accepting Claude Code's `effort` as an alias.** Rejected: two spellings for one option is the asymmetry this repository treats as a missed extraction, and the unrecognized-option message already names `reasoningEffort`, so a model that writes `effort` is corrected on the next call.
- **Substituting the nearest supported effort.** Rejected as the failure the feature exists to avoid, and as a second policy contradicting the LLM seam's.

## Consequences

A workflow script now selects provider, model, and reasoning effort per call, which is what a draft/verify or committee script needs to spend its budget where it matters. Two model-visible texts changed: the `workflow` tool description and the `meta.phases` schema property list.

A per-agent effort binds only for in-process children. The shipped `spawn` backend applies it; every backend that ignores `agentOptions` ignores the effort exactly as it already ignores `provider` and `model` — that is the `acp` backend and, since they shipped, the `subagent-claude-code` and `subagent-codex` providers, which drive their own external CLI and take no route from the parent at all. Host-side validation still runs in each of those cases, so the request is checked against a route the child may not use. Closing that gap is the capability-flag alternative above.

The host now touches the LLM capability, which it previously did not. The dependency is optional and effort-only: a run whose script passes no effort makes no capability query.

## Testing

Focused vitest in `packages/workflow` covers the option surface and the validation policy: an effort alone validated against the inherited route, a per-call `provider`/`model` override moving which route is validated, an unsupported effort and a model with no reasoning at all both killing the script with the route named, an incomplete route, and a deployment without the LLM capability. `packages/subagent/subagent-spawn-in-process` asserts the end of the path against a real child and a real loop: the child's own model request carries the effort while the parent's does not, and a routeless effort rejects the start.

## Related

- [Dynamic workflows](2026-07-05-dynamic-workflows.md) owns the script contract this extends.
- [Adapter-owned reasoning-effort capabilities](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) owns the validation policy this reuses.

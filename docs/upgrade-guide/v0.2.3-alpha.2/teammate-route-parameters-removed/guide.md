---
kind: upgrade-guide
description: "The Team Lead no longer picks a teammate's provider, model, or reasoning effort through spawn_teammate; teammates are subagent children that take the subagent tool's route fields."
---

# Teammate routes come from the subagent tool

English | [中文](guide.zh.md)

## Change

In the previous fork release, `@deepseek-ai/dsh-experimental-tool-agent-team` kept `spawn_teammate` and gave it optional `provider`, `model`, and `reasoning_effort` arguments. The row's `agentOptions` set the teammate route, and without one teammates followed the `subagent` tool's route. `reasoning_effort` alone was accepted and kept the configured route. `list_agents` reported each member's model and reasoning effort.

This release takes the upstream Team design: the package is `@deepseek-ai/dsh-tool-agent-team` and supplies only the four `team_task_*` tools. `spawn_teammate`, its route arguments, and the row's `agentOptions` are removed. A Lead starts teammates with `subagent` or `subagent_fork`, so a teammate's route is that call's route: the `@deepseek-ai/dsh-tool-subagent` row's `agentOptions`, or the call's own `provider`, `model`, and `reasoning_effort` when the row sets `modelSelection: true`. Those fields follow the subagent rules: `provider` and `model` together, and `reasoning_effort` only with both. Per-member model reporting in `list_agents` is gone.

Presets, approval rules, and prompts that name `spawn_teammate`, and `tool-agent-team` rows that set `agentOptions`, are affected. The removed Team tools and keys are mapped in [Agent Teams uses subagents](../../v0.2.1-rc.2/agent-team-subagents/guide.md).

## Migration

1. Replace `spawn_teammate({ name, description, prompt, provider, model, reasoning_effort })` with `subagent({ description, prompt, provider, model, reasoning_effort })`. Remove `spawn_teammate` from preset tool lists and approval or classification rules, and add `subagent` and `subagent_fork` where they are missing.
2. Move a `tool-agent-team` row's `agentOptions` to the `tool-subagent` row, and remove the key from `tool-agent-team`, which no longer reads it.
3. To let the Lead choose a teammate's model, set `modelSelection: true` on the `tool-subagent` row and `modelDiscovery: true` on one instance so `list_subagent_models` is available.
4. Replace an effort-only choice with an explicit `provider` and `model` taken from `list_subagent_models`.
5. Confirm the migration: ask the Lead to start a reviewer teammate on a named model, then check the provider and model on the teammate's first assistant message.

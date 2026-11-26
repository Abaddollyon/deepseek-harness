---
kind: upgrade-guide
description: "Team Lead 不再通过 spawn_teammate 选择 teammate 的 provider、model 或推理强度；teammate 是 subagent 子级，使用 subagent 工具的路由字段。"
---

# Teammate 路由来自 subagent 工具

[English](guide.md) | 中文

## 变更

在上一个 fork 版本中，`@deepseek-ai/dsh-experimental-tool-agent-team` 保留了 `spawn_teammate`，并为它提供可选的 `provider`、`model` 与 `reasoning_effort` 参数。该行的 `agentOptions` 设置 teammate 路由；未设置时，teammate 沿用 `subagent` 工具的路由。单独传入 `reasoning_effort` 也会被接受，并保留配置的路由。`list_agents` 报告每个成员的模型与推理强度。

本版本采用上游的 Team 设计：包名为 `@deepseek-ai/dsh-tool-agent-team`，只提供四个 `team_task_*` 工具。`spawn_teammate`、它的路由参数以及该行的 `agentOptions` 均已移除。Lead 使用 `subagent` 或 `subagent_fork` 启动 teammate，因此 teammate 的路由就是该次调用的路由：`@deepseek-ai/dsh-tool-subagent` 行的 `agentOptions`，或在该行设置 `modelSelection: true` 时调用自己的 `provider`、`model` 与 `reasoning_effort`。这些字段遵循 subagent 规则：`provider` 与 `model` 必须一起提供，`reasoning_effort` 只能与二者同时提供。`list_agents` 中按成员报告模型的功能已移除。

提及 `spawn_teammate` 的 preset、审批规则与提示词，以及设置了 `agentOptions` 的 `tool-agent-team` 行都会受到影响。已移除的 Team 工具与配置键的对应关系见 [Agent Teams 使用子代理](../../v0.2.1-rc.2/agent-team-subagents/guide.zh.md)。

## 迁移

1. 把 `spawn_teammate({ name, description, prompt, provider, model, reasoning_effort })` 替换为 `subagent({ description, prompt, provider, model, reasoning_effort })`。从 preset 工具列表以及审批或分类规则中移除 `spawn_teammate`，并在缺少时添加 `subagent` 与 `subagent_fork`。
2. 把 `tool-agent-team` 行的 `agentOptions` 移到 `tool-subagent` 行，并从不再读取该键的 `tool-agent-team` 中删除它。
3. 要让 Lead 选择 teammate 的模型，在 `tool-subagent` 行上设置 `modelSelection: true`，并在一个实例上设置 `modelDiscovery: true`，使 `list_subagent_models` 可用。
4. 把只指定推理强度的选择替换为从 `list_subagent_models` 取得的显式 `provider` 与 `model`。
5. 确认迁移：让 Lead 在一个指定模型上启动 reviewer teammate，然后检查该 teammate 首条 assistant 消息上的 provider 与 model。

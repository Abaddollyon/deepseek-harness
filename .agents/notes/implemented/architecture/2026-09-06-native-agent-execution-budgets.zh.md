# Agent Note: 原生 agent 执行预算

Status: implemented

[English](2026-09-06-native-agent-execution-budgets.md) | 中文

## Problem

外部调度器保存了模型步骤、输入 token、输出 token 与重试限制，但 headless runner 只向核心 Agent 传递 provider 与 model。仅传输这些数字而不执行，会错误呈现计划运行的隔离能力。

## Decision

`AgentOptions.budget` 为一个实时 agent-loop 实例携带完整的 `{ maxTurns, maxInputTokens, maxOutputTokens, maxRetries }` 策略。循环在下一次提供方分发前准入模型步骤与请求错误重试。它把每次请求的输出上限限制到剩余总量，并在每次尝试后计入提供方报告的输出。

输入 token 是按响应计量的续跑阈值。由于权威 usage 随响应到达，一个提供方请求可能跨过阈值；循环随后拒绝下一次请求。响应 usage 缺失时，必需的续跑以 `BUDGET_ACCOUNTING_UNAVAILABLE` 被拒绝。prepared adapter 可以提供精确输入 token 计数，在分发前拒绝当前过大请求。

headless 应用通过 runner 配置或 `--max-turns`、`--max-input-tokens`、`--max-output-tokens` 与 `--max-retries` 同时接受全部四项限制。成对的 `--provider` 与 `--model` flags 只为本次运行选择路由，不修改已保存设置；可选的 `--reasoning-effort` 应用显式适配器强度 id，而 `provider-default` 会成为缺失强度。这些限制应用于一个 Agent。启动多个子项的调度器拥有任何共享父级分配与 wall-time 截止时间。

## Alternatives considered

**事后截断输出。** 截断已存储文本不会限制提供方生成、工具执行或计费输出，因此循环改为在分发前限制请求。

**要求每个适配器精确计算输入。** 当前提供方在响应后报告权威 usage，但并非全部暴露 tokenizer。拒绝所有有界运行会使受支持的调度器路径不可用，因此精确预检计数是可选能力，响应 usage 决定续跑。

**把每个子项限制视为一个共享 swarm 预算。** 独立进程无法通过本地计数器协调总量。若调度器承诺聚合限制，它必须明确划分或预留共享预算。

## Consequences

模型步骤、重试与请求输出限制会在超额分发前停止工作。输入限制可以被一个在途响应超出，文档必须称其为阈值。聚焦的 fake-adapter 测试在无需提供方凭据的情况下覆盖请求准入、usage 对账、未知 usage、重试拒绝、CLI 校验与 headless Agent 转发。

随附的 basic compaction 后端会在会话循环之外发起独立模型请求。在辅助调用共享预算计量之前，其默认模型摘要器会为预算化 Agent 在分发前以 `BUDGET_ACCOUNTING_UNAVAILABLE` 失败。无模型修剪和子类提供的模型无关摘要器仍可使用；未预算化 Agent 保留正常压缩。

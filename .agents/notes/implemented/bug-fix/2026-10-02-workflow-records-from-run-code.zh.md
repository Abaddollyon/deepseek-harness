# Agent Note: 来自 run_code 的工作流记录

Status: implemented

[English](2026-10-02-workflow-records-from-run-code.md) | 中文

## Problem

`dsh-tool-workflow` 原先只为根工具调用（`exec.parent` 缺省）写入持久的 `tool-workflow/*` 记录，理由是嵌套 transport 调用没有自己的 Chat 行（[聊天中的持久工作流运行](../../archived/feature/2026-08-10-durable-workflow-runs-in-chat.md)）。PTC mode 下 `run_code` 是唯一的顶层工具，模型只能通过 `run_code` 分派调用 `workflow`。因此该模式下每个前台运行都没有记录，Chat 以及任何基于 Session 的工作流视图都无法显示它。

## Decision

每个被接受的 `workflow` 调用都会在调用方 Agent 的 Session 中记录其运行，包括由 `run_code` 分派的调用。只有 `run_code` 桥会设置 `exec.parent`；工作流脚本启动子 Agent 而不是分派工具，子 Agent 自己的调用在其自身 Session 中是根调用，上游本来就会记录。Chat 节点锚定在 `tool-workflow/run-start`，分派的运行会在仍未结束的 `run_code` 调用内追加该事件，因此它显示在该调用行之后，与根运行显示在自身调用行之后一致。

## Alternatives considered

**保持只记录根调用，并在 `run_code` 旁暴露 `workflow`。** 这会扩大 PTC mode 的工具面，而该模式存在的意义正是只保留一个顶层工具；模型选择分派的运行仍会丢失。

**通过 token 识别父工具。** token 有意保持不透明，且 `run_code` 是其唯一生产者，额外查询只会新增 API 而不改变任何结果。

## Consequences

PTC mode 的工作流运行与根运行一样能在刷新后保留。将来若有设置 `exec.parent` 且不希望记录的组合 transport，必须在此处添加自己的条件。

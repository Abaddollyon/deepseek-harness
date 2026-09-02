# Agent Note: 公开 Claude Code 适配器 helper

Status: implemented

[English](2026-09-02-claude-code-adapter-public-exports.md) | 中文

## 问题

Claude Code subagent 包已经拥有官方 Agent SDK 选项投影，以及把 SDK spawn 请求转换为 Harness 托管 `ctx.subprocess` 进程树的逻辑。Claude Code web-search 提供方需要相同边界。导入包私有源码路径会使其发布包布局不稳定，而复制进程适配器会为同一个 CLI 产生两套清理与环境策略。

## 决策

`@deepseek-ai/dsh-subagent-claude-code` 从包根公开四个适配器符号：

- `claudeSpawnSpec` 把 Agent SDK spawn 请求转换成完整的托管 subprocess 规格。
- `ManagedClaudeCodeProcess` 把 `SubprocessHandle` 投影回 Agent SDK 期望的进程接口。
- `sdkEnvironmentOverlay` 构造显式 SDK 子进程环境 overlay，同时不绕过 subprocess 凭据清理。
- `claudeQueryOptions` 构造共享的非交互 Agent SDK query 选项。

这些是公开集成 seam，而不是第二套提供方 API。web-search 包从包根导入进程投影，同时继续拥有仅搜索工具策略、结构化输出 schema、超时、错误分类和请求生命周期。包根再导出测试保证公开入口与实现符号保持引用相等。

## 考虑过的替代方案

**把适配器复制到 web-search 包**被拒绝，因为环境清理、stdio 投影、退出映射或进程树清理的修复可能在两个 Claude 功能之间产生分歧。

**直接导入 `src/process.ts` 与 `src/run.ts`**被拒绝，因为源码子路径属于实现细节，并非稳定的发布包约定。

**把 helper 移到新的 Claude SDK 工具包**被拒绝，因为 subagent 适配器仍是其实现所有者，而额外包会增加依赖与发布面，却没有分离出独立策略。

## 后果

Claude 功能共享同一套经过测试的 SDK/subprocess 边界，消费者可以依赖稳定包根导出，而不是源码布局。公开名称与语义在 subagent 实现变更时必须接受兼容性审查。搜索专属策略仍留在共享适配器之外，避免可复用的进程 helper 变成隐藏协调器或回退链。

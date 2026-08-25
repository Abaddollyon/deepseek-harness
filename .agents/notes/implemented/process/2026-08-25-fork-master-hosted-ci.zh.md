# Agent Note: Run fork master CI on hosted infrastructure

Status: implemented

[English](2026-08-25-fork-master-hosted-ci.md) | 中文

## 问题

fork 的 master 分支会直接接收推送，因此需要一个阻塞式信号；但上游 master 工作流把推送任务交给私有的 self-hosted runner 池。现有 pull request 工作流只监听 pull request，无法提供这个信号。

经过 supersession 检查，没有找到 fork 专用 master CI 的现有 Agent Note。

## 决策

独立的 ci-fork-master.yml 工作流在 master 推送和手动触发时运行一个 Ubuntu 托管 runner 任务。该任务先运行 pnpm run check:ci:static，再运行 pnpm test。静态命令仍由 scripts/run-gates.ts 负责，因此构建相关检查不会分裂成另一份定义。

上游的 ci-master.yml 保持不变：其中的 self-hosted 任务属于上游仓库，在提供这些 runner 池的环境中仍然可用。

## 考虑过的替代方案

**修改 ci-master.yml 来替换 runner。** 否决，因为这会删除上游的 self-hosted 验证，并造成永久的 fork/upstream 合并冲突。

**将完整的上游矩阵复制到托管 runner。** 否决，因为每次推送会启动九个任务，超出 fork 可负担的 gate 预算。

## 后果

fork 获得了实际执行的托管静态/unit 信号，但每次 master 推送不再运行上游的覆盖率、平台矩阵或原生 runner 检查。仍可通过手动触发进行验证。

## 验证

已通过 GitHub Actions 触发分支工作流；运行 URL 和结论会与实现一起记录。

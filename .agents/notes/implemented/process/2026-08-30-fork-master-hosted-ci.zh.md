# Agent Note: Run fork master CI on hosted infrastructure

Status: implemented

[English](2026-08-30-fork-master-hosted-ci.md) | 中文

## 问题

fork 的 master 分支在变更落地时需要一个阻塞式信号，但上游 master 工作流把推送任务交给私有的 self-hosted runner 池，上游 pull request 工作流又把静态检查和覆盖率通道交给私有的 enterprise runner 池。fork 两种池都无法分配，因此这两个工作流在 fork 上都不会执行代码 gate；上游 master 工作流里唯一的托管任务只是 Wine 缓存播种。

经过 supersession 检查，没有找到 fork 专用 master CI 的现有 Agent Note。

## 决策

独立的 ci-fork-master.yml 工作流在 master 推送、目标为 master 的 pull request 以及手动触发时运行一个 Ubuntu 托管 runner 任务。该任务先运行 pnpm run check:ci:static，再运行 pnpm test。静态命令仍由 scripts/run-gates.ts 负责，因此构建相关检查不会分裂成另一份定义。archived-note 封存 gate 会按事件获得可信的变更前提交：pull request 的 base、推送前提交，或手动触发时检出的 HEAD。

上游的 ci-master.yml 和 ci.yml 保持不变：其中的 self-hosted 和 enterprise 任务属于上游仓库，在提供这些 runner 池的环境中仍然可用。任务级 guard 把该工作流限制在 fork 仓库（github.repository == 'Abaddollyon/deepseek-harness'），因此文件随仓库传播到任何位置都只报告 skipped，而不消耗运行时长；同一 guard 还把手动触发固定在 master 上，使其无法指向任意 ref。workflow-policy 规格精确固定该 guard，并把该 gate 固定为仅托管、无密钥、只读，并且只覆盖 fork 主干。无密钥是一条词边界 token 策略：规格在解析后的工作流中把 secrets 上下文按大小写不敏感的完整词扫描，因此点写、下标写、插入空格的写法以及 toJson(secrets) 这类整体上下文写法都会被拒绝，而仅包含该子串的标识符仍然允许。

## 考虑过的替代方案

**修改 ci-master.yml 来替换 runner。** 否决，因为这会删除上游的 self-hosted 验证，并造成永久的 fork/upstream 合并冲突。

**将完整的上游矩阵复制到托管 runner。** 否决，因为每次推送会启动九个任务，超出 fork 可负担的 gate 预算。

**依赖上游 pull request 工作流覆盖 fork 的 PR。** 否决，因为它的静态检查和覆盖率任务使用在 fork 中永远无法分配的上游 enterprise runner 标签。

## 后果

fork 在 master 推送和目标为 master 的 pull request 上获得实际执行的托管静态/unit 信号，代价是这些事件不再运行上游的覆盖率、平台矩阵或原生 runner 检查。仍可通过手动触发进行验证。

## 验证

workflow-policy 规格、Agent Note 格式与分类 gate 以及 translation-pairing gate 均在本地通过。该工作流到达 fork 默认分支后，由集成变更记录 fork master 上的首次托管运行。

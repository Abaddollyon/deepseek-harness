# Agent Note: Alpha 5 集成树重新基线

Status: implemented

[English](2026-09-02-alpha5-rebaseline.md) | 中文

## 问题

一次性的重新基线必须在不依赖仓库外 disposition ledger 的情况下，让集成树的来源、seam 选择、丢弃工作和无密钥验证证据可复现。

## 决策

集成后的重新基线以上游标签 dsh-v0.1.2-alpha.5 为基础，记录已完成的 22 条 lane、126 个 carry 的协调结果：92 个保留、18 个适配、16 个丢弃。一次性的全量生成和无密钥本地门禁构成集成树的发布证据。

采用的 seam 是用于有序会话状态的 SessionSeq/SessionLogOffset、用于串行控制的 Deque ControlQueue、用于生命周期激活的 ActivationObserver、用于配置的 settings injection、用于 Host/Client 工作区边界的 hostInfo/UiWorkspace，以及位于存储域上的持久 Jobs。

当某项行为已经通过更新的 seam 重新落地、依赖主机上不存在的模型凭据、重复生成产物，或代表已被取代的架构时，carry 会被丢弃。最后的覆盖率 carry 只覆盖集成树上仍未覆盖的候选路径；已知 hosted-runner flaky 列表不通过削弱测试处理：agent-team persistence.spec.ts:215、inspector integration.host.spec.ts:381、session-snapshot harness waitFor，以及 terminal-bash local.spec.ts:331。

## 备选方案

**重新记录所有 golden。** 主机上刻意没有模型凭据，因此保留依赖模型的输出，不猜测其结果。**只把外部 ledger 作为唯一记录。** 本 Note 在仓库内保存 disposition 摘要，便于维护者评审。

## 验证

已在集成树上运行一次全部生成器。PR 中报告无密钥 expected、snapshot replay、packed-session migration/layout、static、文档、构建、lint、unit、GUI 和 web replay 门禁；没有重新记录任何依赖模型的 golden。

## 影响

这里总结 disposition，而不依赖仓库外的 REBASELINE-R1-DISPOSITIONS.json 路径。后续变更必须保留采用的 seam，并说明任何新的 carry 或 golden 刷新。

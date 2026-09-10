# Agent Note: Client 重复代码的归属

Status: implemented

[English](2026-09-10-client-duplication-ownership.md) | 中文

## 问题

Client feed 所有者、浏览器存储消费方、导航流程与 Loader 激活路径重复实现了行为，但各自具有不同的生命周期和错误处理义务。独立副本可能导致清理顺序、迁移语义和清理错误报告不一致。

## 决策

`@deepseek-ai/dsh-api-gateway/client` 提供可复用的 `RemoteFeedLifecycle`，负责按顺序 dispose 流、取消重试定时器、使过期回调失效，以及分派清理失败。Session 和 Workspace feed 所有者保留各自的就绪状态、重试准入和失败发布逻辑。

`@deepseek-ai/dsh-client-store` 提供 `migrateLocalStorageKey`；UI 和 Session 消费方通过它执行旧 key 的一次性迁移，保持浏览器存储失败不影响运行的尽力而为语义。导航完成与 Loader 逆序移除仍是所属包内的私有辅助函数，因为它们的回调和错误聚合与各自领域相关。

## 考虑过的替代方案

**保留重复实现。** 未采用，因为检测器发现了相同的生命周期与清理行为，其顺序要求必须保持一致。

**创建通用工具包。** 未采用，因为 Gateway 和 Client Store 已经负责相关的运行时功能；在没有其他消费方的情况下，新包只会扩大依赖关系。

**抑制或规避检测器。** 未采用，因为这样仍会保留实现分歧，并且不提供行为保证。

## 后果

Feed 清理行为只有一份实现，专用测试覆盖流的顺序、定时器取消、dispose 拒绝和所有者失败处理。存储迁移只有一份实现，测试覆盖迁移、目标优先以及存储不可用。领域特定的重试与导航行为仍由相应 Client 测试负责；快照格式和模型可见行为均不改变。

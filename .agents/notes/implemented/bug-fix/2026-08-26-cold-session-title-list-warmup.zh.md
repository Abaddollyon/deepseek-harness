# Agent Note: 冷会话标题的异步列表预热

Status: implemented

[English](2026-08-26-cold-session-title-list-warmup.md) | 中文

## Problem

Web 会话列表从 projection cache 获取持久化标题。冷会话缺少 cache 行时，即使标题存在于磁盘上的持久会话日志中，也会在没有标题的状态下到达客户端。客户端随后使用 workspace 目录 basename，导致同一 workspace 中的大量会话显示相同标签。现有 session-query 标题读取器已经可以使用，但为每一行同步调用会把聚合轮询变成全库扫描。

## Decision

createApiProxy 按 session id 以及持久 header 身份（createdAt 与 cwd）维护进程内标题观测缓存。冷列表行没有缓存的 title 投影时，session.list 立即返回已知元数据，并将该行加入一次异步批量 sessionQuery.readTitleSnapshots 读取；响应不会等待读取完成。下一次列表轮询会把已完成的标题合并到 projection block；没有标题或读取失败的行保持原状。projection cache 中已有的值继续优先，header 变化会使进程内观测失效。

一次列表调用发现的所有候选会作为一个批次提交，因此约 1,553 条冷行的列表最多触发一次标题观测操作；持久化检查并发数由 session-query 的配置控制（默认四个）。后续轮询不会重新读取已经定局的行。现有有界 cold-blank 探测仍是 session.list 中唯一同步的冷日志工作。

这部分取代了[resume selector 批量 projection](2026-07-31-resume-selector-batch-projection.zh.md)中“冷会话直到 resume 前只提供元数据”的陈述。该 note 关于 projection cache 与有界读取的决定仍然有效；仅 Web 列表的标题可见性发生变化。

## Alternatives considered

**在 session.list 中同步读取所有冷日志。** 拒绝，因为聚合轮询会等待整个 corpus 的解压和检查，破坏列表响应性。

**增加第二个持久标题索引。** 拒绝，因为标题事件已经由 session-query 提供了归属明确的批量读取器；第二个索引会引入失效、崩溃恢复和迁移义务。

**让 projection cache 同步回填每个缺失行。** 拒绝，因为 cache 持久化是异步优化，列表响应不应依赖 cache 写入完成；进程内预热也避免改变只读列表路径的 cache 所有权。

**继续返回 basename fallback。** 拒绝，因为它会掩盖已有持久标题并制造误导性冲突；客户端的带日期未命名标签只是诚实 fallback，不是标题恢复。

## Consequences

cache miss 后的首次列表响应仍然快速，并且可能暂时不含标题；后续轮询无需 attach 或 resume 会话即可获得持久标题。预热只为遇到的冷行保留一个小型 header-keyed 记录，并将读取失败隔离在列表响应之外。进程重启会丢失预热 map；在 projection cache 通过正常会话活动填充前，冷行会再次触发一次批量观测。会话格式、projection schema 与客户端 identity 行为保持不变。

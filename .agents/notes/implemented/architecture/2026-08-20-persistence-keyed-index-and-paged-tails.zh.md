# Agent Note: A keyed session index and seek-capable tail reads

Status: implemented

[English](2026-08-20-persistence-keyed-index-and-paged-tails.md) | 中文

## 问题

有两种读取主导了冷加载开销，而且两者都是 O(corpus)。

JSONL 后端的 `list()` 会打开每个产物以恢复其头部。包含一千个会话的记录集意味着需要打开一千个文件；使用 zstd 压缩时，还要解码一千个帧，之后 GUI 才能绘制会话列表。实测部署包含 1,036 个日志，共 551 MiB。

`history` 无法请求有界的尾部。每个后端都会物化完整的已存储日志，再由调用者切片，因此打开一个需要读取 500 个轮次历史的对话时，会读取并解码该会话的每个事件，只为显示最后一页。

## 决策

**在产物旁维护持久化键控索引。** JSONL 后端写入 `session-index.json`（`JSONL_INDEX_FORMAT_VERSION = 1`），其中每个产物对应一个 `SessionIndexEntry`。`list()` 读取索引并返回头部，无需打开任何日志。新鲜度按产物计算（`indexFreshness(identity)` 作用于 `FileRevisionIdentity`，并通过 `sameFreshness` 比较），因此过期或缺失的条目只会修复对应产物：`repairIndexedArtifacts` 重新读取发生变化的内容，`discoverUnindexedArtifacts` 纳入新出现的内容，而 `rebuildIndex` 是索引不存在时的冷路径。索引写入通过 `withIndexLock` 串行化。

**在持久化接缝上提供寻址钩子。** `SessionPersistence.loadStoredTail?(id, beforeSeq, limit, signal)` 是可选方法：支持寻址的后端实现它，顺序后端则省略它。协调器的公共方法 `readTail(id, beforeSeq, limit, signal)` 会验证边界（`beforeSeq` 为非负安全整数或 `undefined`；`limit` 为正安全整数），等待与其他所有读取相同的延迟写入屏障，按会话串行化，然后调用该钩子或对完整前缀进行切片。它返回 `StoredTail`——一个按 seq 升序排列的页面，以及此前是否还有更早的有效事件——并附带分离的元数据，因此调用者可以向后翻页而无需持有日志。

**SQLite 直接从存储读取尾部。** `SCHEMA_VERSION` 升至 18，并加入物理块行编解码器；`readTail` 从边界开始反向遍历已存储行，而不是重建逻辑日志。

**冻结事件保留、异步 zstd 和头部缓存** 也随此变更一起实现：索引缓存了头部读取过去需要重新计算的内容，解码移出同步路径（`decodeCompleteZstdFrame`），保留机制则保存尾部读取所依赖的冻结前缀。

## 备选方案

**信任索引，只在显式命令下修复。** 否决：会静默地与产物不一致的持久化索引比没有索引更糟，因为其上层的每个消费者都会继承错误信息。按产物的新鲜度让不一致检测成本低廉，并将修复限制在局部；正因如此，索引才值得信任。

**要求持久化接缝必须实现 `loadStoredTail`。** 否决：顺序后端若不物化日志就无法实现它，而这正是要避免的开销。可选方法加回退方案使接缝如实反映能力——两类后端的协调器契约相同，仅成本不同——而且包规则要求为所有当前 Consumers 设计 Service Definition，而不是只为最快的后端设计。

**让调用者自行从 `load()` 中切取尾部。** 否决：这就是现状，它让每个调用者都要负责分页边界，却仍使读取没有边界。

## 影响

使用索引的 `list()` 不执行任何头部读取；实测场景从打开一千个产物降至读取一个索引。`SESSION_FORMAT_VERSION` 保持不变——索引是日志旁的派生数据，并非日志格式变更——而 SQLite 存储将单调递增的 `SCHEMA_VERSION` 提升到 18；仓库的预发布立场允许直接拒绝更旧的磁盘状态。没有寻址钩子的后端仍可按原有成本工作，因此组合选择不受限制。索引是一个新的持久化文件，部署的备份与清理流程必须将其纳入管理。

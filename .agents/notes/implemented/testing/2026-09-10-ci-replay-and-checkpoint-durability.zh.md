# Agent Note: CI 回放输入与 checkpoint 完成

Status: implemented

[English](2026-09-10-ci-replay-and-checkpoint-durability.md) | 中文

## Problem

已发布的 Session generation 提供持久读取验证，但其原始写入输出未必匹配同一格式版本中有意新增的行为。替换该 generation 会破坏读取 fixture；从比较中移除 workflow phase 或子 Session label 则会隐藏持久化行为。另外，在自动写入尚未完成时读取原子替换目标的缓存测试，无法区分未完成操作、写入拒绝与过期 checkpoint。

## Decision

### 不可变回放输入与严格写入期望

[Snapshot manifest](../../../../packages/test-support/session-snapshot/src/manifest.ts) 为自有的当前格式 headless 与 ACP 回放输入接受 `writerOracle: separate`。它独立于历史 `sessionFormat` 保留声明，不能与该声明或外部 `session` 引用并用。现有 generation 文件继续作为回放输入；`writer.expected.jsonl` 及带序号的子文件保存完整的原生写入输出。Adapter 与 [corpus 检查](../../../../scripts/session-snapshot-corpus.corpus.ts) 共用[清单断言](../../../../packages/test-support/session-snapshot/src/session-files.ts)，要求父子 oracle 清单精确匹配，并使用当前格式 header。历史保留仍要求格式早于当前 writer。

独立 oracle 保留有意写入的 workflow phase 事件、子 Session label 及相应事件引用。缺少当前 generation fixture 的场景则新增真实的原生 writer 后继文件；仅转换旧文件的 schema 不能证明当前 writer 行为。Prompt 与 schema sidecar 跟随其所属功能所声明的输出，而不是为匹配过期文本移除受支持选项。

Recorded job 场景在记录与回放 composition 中都使用[实例内确定性 identity hint](../../../../apps/cli/tests/profiles/sdk/fixtures/deterministic-jobs.ts)。准入限制、存储与执行仍由真实 registry 负责。[重试 adapter](../../../../apps/cli/tests/profiles/headless/tests/fixtures/retry-snapshot-backend.mjs) 区分标题请求与主请求，避免标题生成消耗主请求的瞬时失败序列。

### Checkpoint 顺序与可观察完成

[Projection cache](../../../../packages/session/session-projection-cache/src/index.ts) 在捕获 checkpoint row 时预留每个 Session 的写入顺序，再等待日志 flush 完成。因此，延迟的创建 flush 不会让较旧 checkpoint 排在较新的事件或销毁 checkpoint 之后写入。被拒绝的 flush 保留其队列位置，直到先前写入结束；它不会发布未刷入日志的 row，并允许后续写入恢复。日志 flush 仍在 Session 存活时启动，不会延迟到 detach 之后。

自动写入测试观察真实的 `cache.write` 调用，断言触发它的生命周期或事件计数，等待其返回的 promise，再读取磁盘 JSON。真实 `session/flush` listener 的 barrier 固定乱序就绪的时序。这些测试既不替换存储，也不在写入过程中轮询替换目标。

### 图像压力与裁剪后的准入

[自动 compaction](../../../../packages/compaction/compaction-basic/src/index.ts) 在裁剪 tool result 后，同时复查配置的软阈值与请求硬容量。已挂载但没有移除内容的 pruner 不能仅因请求仍低于硬容量就阻止摘要 compaction。[图像场景](../../../../snapshots/acp/image-compaction/cordis.snapshot.yml) 保留 pruner，并为摘要输出独立于主输出分配预算。摘要限额为含图像的历史留下空间；保留尾部设置阻止首轮 compaction，同时允许在后续输入之后进行 compaction。按图像计价的压力超过软阈值，而其他条件相同的纯文本测量仍低于该阈值。

ACP 协议期望与已发布 Session generation 不同：`stdout.expected.jsonl` 断言当前客户端可见响应。图像场景要求 `DONE`，而不是被主请求意外消耗的摘要。协议期望跟随已验证的修复行为，而已发布 Session 输入保持不可变。

### Sidebar 原生归属与渲染器复合键

[Sidebar 装配](../../../../packages/client/ui-sidebar-right/src/client/index.ts) 将每个创建的 store 与其绑定动作关联，并通过两个共享 store 席位中任一个的原生 `inject(sessionId, actions)` 参数收养实例。渲染器工厂键是不透明的 Host/Session 存储标识，而非原生 Session id。把它当作原生 id 会让初始引导 tab 缺少已提交 occurrence，因为 store 动作按原生 id 写入。每个实例只建立一次收养关系；store 提交对齐离屏记录，插件销毁释放订阅并中止 occurrence。

解析渲染器键会让功能依赖私有编码，移除 Host 命名空间则会造成跨 Host 冲突。在渲染期间分配 occurrence 会绕过已提交记录的归属。[原生注入回归](../../../../packages/client/ui-sidebar-right/tests/apply.client.spec.ts) 固定首次提交与 header 先行收养行为；[真实渲染器及 Session adapter composition](../../../../packages/client/ui-sidebar-right/tests/host-session.client.spec.tsx) 验证两个 Host 共享原生 Session 与 tab id 时，store、signal、动作及销毁仍彼此独立。构建后的装配浏览器执行仍是单独的产物验证。

### Worker Preview 响应

Worker 隧道提供真实 Web 载体策略所使用的响应方法，包括可变响应头、单次监听器、可重新定义的生命周期属性，以及 write/end 回调。正常完成先发出 finish 再发出 close；取消会结算待处理回调，但不再发布隧道帧。这修复了策略安装到不完整合成响应上导致的 Preview 脚本包 HTTP 400，且不绕过策略或路由信任检查。归属包测试将生产响应策略应用于合成交换；打包后的 Preview 浏览器测试仍负责组装验收。

### Workspace 临时行

[Workspace 浏览器](../../../../packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx) 的五行配额只适用于非空白 Session。当前选中的临时新会话保留其排序位置并持续可见，不占用该配额；展开控件只统计实际隐藏的行。首条提示词使该 Session 不再空白后，它占用普通配额。仅把总截取数量增加一条仍会隐藏排在截取范围之外的临时行，而把临时行计为隐藏则会错误报告展开数量。源码回归覆盖排序两端、恰好和超过配额、重新打开及首条提示词转换；装配浏览器验收仍单独负责。

### 模型选择器焦点

composer 模型选择器仅在 portal 定位结果可见后转移焦点。根面板、模型搜索面板与推理强度面板各自负责初始焦点；窗口缩放、滚动与目录刷新不会重置用户导航。回归测试模拟浏览器拒绝聚焦隐藏测量节点的行为，构建后的模型选择器发现测试继续保留根菜单 Model 行的自动聚焦断言。

## Alternatives considered

**刷新已提交 generation，或在 normalization 中移除新事件。** 拒绝，因为前者破坏已发布读取验证，后者移除对有意义持久化输出的严格检查。虚构格式升级也会错误描述 writer 格式。

**把当前格式保留当作历史迁移覆盖。** 拒绝，因为它会弱化历史版本约束，并混淆 reader 迁移与 writer 演进。

**修改生产 job identity，或让不同请求用途共享重试序列。** 拒绝，因为场景确定性属于测试 composition，而标题生成并不是被测主请求。

**禁用 pruner，或接受没有 compaction 的回放。** 拒绝，因为两者都会隐藏裁剪后的阈值缺陷。场景预算必须允许预期 compaction，回放仍须在总结图像历史后到达最终主响应。

**仅延长等待缓存文件的时间。** 拒绝，因为稍后读取不能修复 checkpoint 超越，也不能暴露被吞掉的自动写入拒绝。每个 Session 的排序与显式写入完成分别解决不同义务。

## Consequences

部分场景同时维护回放输入与写入期望。额外存储换取独立的 reader 与 writer 断言，而不弱化任何一方。Corpus 检查拒绝缺失、多余、名称错误及版本错误的 writer oracle；完整输出回放仍是必需验证。

缓存回归在 Linux 上证明了 checkpoint 超越。它没有证明 Windows 文件系统 errno，也不能完整解释最初的 Windows 阈值测试失败。托管 Windows 执行仍负责平台验证；本地 coverage 不能替代它。

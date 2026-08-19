# Agent Note: Trajectory derivations reuse identity instead of rebuilding the session

Status: implemented

[English](2026-08-19-trajectory-derivation-identity-reuse.md) | 中文

## Problem

每个流式分片都会重建整个 Trajectory 读模型，因此在长会话上主线程的上限约为每秒 29 个分片。

`TrajectorySnapshotBuilder.apply()` 总是执行一次完整的 `snapshot()`：遍历全部 contribution，对 request 与已定稿节点排序，并返回全新的 `eventNodes`、`eventLocations`、`requests`、`callSchemas` 与 `runningCalls` 标识。内容其实并未移动——一次 `assistant/chunk` 只推进进行中的 partial——但 React 看到的是新对象，于是 `TrajectoryView` 的已定稿 memo 重新执行 `deriveTrajectoryLayout`，进而重新执行 `TrajectoryTable` 中的七个派生流程。

`deriveTrajectoryLayout` 自身没有增量能力。它会在全部节点上重建结果索引、已发出的调用 id 与后继助手索引，重新排序每个布局条目，并为每条记录分配新的 `TrajectoryCellProps`，因此没有任何单元格能跨渲染存活。

在磁盘上最大的会话上实测——93,230 条原始事件重建为 6,438 个对话节点与 5,680 个 trajectory 单元格——每个分片的纯 JS 开销为 34.5 ms：其中 29.3 ms 在 `deriveTrajectoryLayout`，其余在表格的派生流程。还伴随两处泄漏：只要选中了区间，时间线模型每帧就会投影两次；实时搜索则在每个 token 上重新扫描整个会话的全部单元格。

## Decision

**两处派生都通过折叠到上一次结果之上来发布。** 派生本身仍是完整的——builder 遍历全部 contribution，布局遍历全部条目——但发布的内容会在其未发生移动之处复用上一次的标识。下游 memo 读取的是标识而非重算结果，真正的开销正在此处。

**`TrajectorySnapshotBuilder` 把每个快照折叠到上一次发布的快照上。** `publish()` 把每个等价的数组成员与 map 取值重写为先前发布的对象；容器内没有移动时返回原容器；所有分区都未移动时返回原快照对象。折叠逻辑由 `packages/client/ui-trajectory/src/client/derived-identity.ts` 拥有：`isEquivalent` 会下降到数组与纯对象内部，其余一律按标识比较，因为重建 Map 的派生也会重建其成员。这些辅助函数会接管新容器并就地重写，因此经过它们的值对所有调用方都是只读的。

这是刻意选择的"先验证再复用"，而非就地打补丁：每次刷新仍从 contribution 构建快照，任何增量路径都不可能偏离权威遍历。只推进 partial 的分片开销为 0.77 ms，且所有已定稿分区保持不变。

**`deriveTrajectoryLayout` 接受一个可选的按视图缓存。** `createTrajectoryLayoutCache()` 返回一个已挂载 `TrajectoryView` 在其每次派生时传入的 memo；`TrajectoryView` 用 `useState` 持有它，使其与视图同生共死。该缓存包含四个相互独立的 memo：

- **按记录的展开。** `laidFor` 以产生这些单元格的输入对象——节点、request 或提示词变更——作为键，并针对该记录的起始索引、其声明的依赖以及每个已产出单元格读取过的工具 schema 校验命中。助手的依赖是前序墙钟时间，外加每个 tool-call 块的结果、调用起始时间与调用块。命中时返回先前的 `LaidCell` 对象，因此单元格保持标识；未命中则重新展开并重新附加 schema。
- **节点派生索引。** 当新的 `nodes` 数组以完全相同的先前成员开头时，`nodeIndexesFor` 就地扩展上一次派生的布局条目、结果索引、调用起始时间、已发出的调用 id、后继助手与已表示的 step；否则重建。追加只扩展尾部；加载更早的一页则重建。
- **按轮次的模型。** 当某轮次的分组持有相同标题与相同单元格对象时，`turnModelFor` 复用其模型，从而跳过分组墙钟跨度描述，并保留被 memo 化的 `TrajectoryTable` 所读取的模型标识。
- **结果数组。** 所有轮次模型都被复用的派生会重新发布上一次的数组，因此未移动的输入无法使下游 memo 失效。

**缓存对正确性从不承重。** 不传缓存的 `deriveTrajectoryLayout(input)` 会重新展开每条记录，两条路径只有标识不同。该参考路径正是等价性测试的比较对象，因此缓存可以无条件启用，而无需藏在开关之后。

**工具 schema 在展开时附加。** 原先遍历每个分组、为每个单元格重复执行 `JSON.stringify(schema, null, 2)` 的收尾循环已被移除；`attachSchemas` 在 memo 边界内运行，序列化文本按 schema 对象记忆化，且每个单元格读取过的 schema 是缓存键的一部分，因此后到的 schema 会重新展开其单元格，而不是修改早先渲染已发布的那一个。

**时间线模型每帧派生一次。** `TrajectoryView` 派生它并作为 owner prop 传给 `TrajectoryTimeline`；`trajectoryTimelineFocusIndexes` 现在接受模型，而不再接受布局与 mode。`deriveTimedTimeline` 用循环而非 `Math.min(...spans)` 计算其定义域边界——当一个轮次持有长会话的全部单元格时，参数展开会导致栈溢出。

**实时搜索按布局拆分其匹配集合。** 已定稿索引集合是以已定稿折叠为键的独立 memo，进行中集合是第二个 memo；当 partial 没有任何匹配时完全跳过求并。因此一个流式 token 只重新扫描进行中的尾部。

## Measured effect

同一会话，Node 25.9.0 下 7 次运行的中位数，与 `HEAD` 对比：

| 路径 | 之前 | 之后 |
|---|---|---|
| 单个流式分片的 `apply()` | 1.12 ms | 0.77 ms |
| `deriveTrajectoryLayout` | 29.3 ms | 追加一个节点时 5.8 ms |
| 完整流水线（布局 + 表格的五个派生流程） | 34.5 ms | 追加一个节点时 13.5 ms |
| 不追加已定稿节点的分片 | 34.5 ms | 0.77 ms——所有下游 memo 均命中 |

被实测会话的 93,230 个事件中，有 68,995 个是 assistant 或 tool-call 内容分片，它们只移动进行中的 partial，落在 0.77 ms 这一行。会追加已定稿节点、开启 step 或移动运行中调用的事件——assistant 消息、工具结果、step 开始与代码派发，约占日志的四分之一——则走追加那一行。

## Alternatives considered

**在非结构性路径上就地打补丁修改快照。** 审计提议替换唯一改变的 `finalized[i]` / `requests[i]` 槽位并跳过排序。这能省下 0.7 ms 的遍历，但遍历从来不是开销所在——它发布出的标识抖动才是——而一条可能与权威折叠产生分歧的补丁路径，恰恰是最难测试的失效模式。在完整构建之后再折叠，能获得同样的下游效果，且不引入第二个真源。

**从检查点恢复布局折叠。** 在轮次边界快照折叠状态、只重放尾部，可以进一步削减每次追加的残余开销。但若不能证明任何后到的输入都无法触及已检查点化的记录，该做法就不成立，而后到的输入确实会触及：工具结果会改变更早助手的工具单元格；尾部的用户消息在其助手到达时会被重新定位。带依赖追踪的记忆化把这些关系显式声明出来，而不是假定它们成立。

**用配置字段开关增量路径。** 客户端插件收不到任何配置：启动图只携带 `id`/`url`/`rev`/`inject`/`immediately`，且外壳以 `loader.create({ name })` 创建每个 entry，因此浏览器半侧导出的 `Config` 永远不会被读取。开关只能是模块常量，那并非可配置性。等价性测试使该开关变得不必要。

**把时间线模型留在 `TrajectoryTimeline` 内并加强 memo。** 第二次派生位于另一个组件的 memo 中（`trajectoryTimelineFocusIndexes`），因此在时间线内部无论怎样记忆化都无法消除它。把模型提升到同时拥有两个消费方的那个 owner，是重复项唯一会消失的地方。

**在同一变更中重构 `TrajectoryTable`。** 其五个派生流程占追加分片剩余开销中的 7.7 ms。在不追加任何内容的那 93 % 分片上它们已经免费，而要进一步削减就意味着从 3,074 行的组件体中抽出一个被 memo 化的行组件——那是一次自带风险的独立变更，而非本次变更的搭车项。

## Consequences

单元格、轮次模型、快照分区与布局结果数组现在跨渲染共享。任何代码都不得修改这些派生返回的值；原先会这样做的 schema 附加逻辑正是因此移入缓存边界内，而 `derived-identity.ts` 在其辅助函数上声明了这一义务。

`TrajectoryTimelineProps` 新增必填的 `model`，因此每个渲染点都需要提供它。`trajectoryTimelineFocusIndexes` 接受模型而不再接受 `turns` 与 `mode`。

在 6,438 个节点的会话上，追加路径仍需 5.8 ms 布局加 7.7 ms 表格流程。加载更早的一页会重建全部索引并重新展开每条记录，这是正确的，且不比之前更慢。

## Testing

`tests/layout.client.spec.tsx` 在一次追加序列的每个时点上分别带缓存与不带缓存地派生，并断言二者相等，因此任何分歧都会大声失败；其余用例还固定了：追加事件会保留未受影响单元格与轮次模型的标识；后到的工具结果只重新展开它所移动的那条记录；后到的工具 schema 会重新展开其单元格；未移动的输入会重新发布同一个数组；以及前置加载的历史能够正确重建。`tests/snapshot-builder.client.spec.ts` 固定了：只推进 partial 的分片会原样重新发布所有已定稿分区；没有移动任何内容的 upsert 会重新发布同一个快照对象；追加一个事件会保留此前每个节点的标识。

## Related

[Trajectory assembly from registered Conversation Contexts](2026-08-11-trajectory-conversation-context-assembly.md) 拥有 contribution 如何到达 builder 的部分；本文拥有 builder 与布局从中发布什么的部分。

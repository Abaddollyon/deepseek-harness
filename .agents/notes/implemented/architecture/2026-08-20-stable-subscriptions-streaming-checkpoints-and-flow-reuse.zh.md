# Agent Note: Three render-path wins — stable subscriptions, streaming checkpoints, flow reuse

Status: implemented

[English](2026-08-20-stable-subscriptions-streaming-checkpoints-and-flow-reuse.md) | 中文

## 问题

三个相互独立的热点路径共享同一种模式：每次更新都会重建一个输入并未改变的对象。

**插槽渲染器每次渲染都会重新订阅。** `SlotOutlet` 和 `RootOutlet` 将内联闭包传给 `useSyncExternalStore`。每次渲染产生的新闭包都会带来新的订阅身份，因此 React 每次渲染都会为每个 outlet 进行一次取消订阅和重新订阅——这项成本会永久地累积到树中的每个 outlet 上。

**流式 markdown 会重新解析不稳定的尾部。** 每个到达的块都会重新解析一个不断增长、语法尚未稳定的后缀，因此解析成本会随着消息增长而增长：对于流式回复的长度呈二次增长。

**AgentFlow 模型会整体重建，并通过扫描连接子节点。** 每个子节点都使用 `sources.find` 查找其来源；在宽扇出中这会呈二次增长——正是 swarm 产生的结构——而且整个模型会被重新计算，而不是向前推进。

## 决策

**按 host 和 key 缓存订阅对。** `keySubscriptionCache` 是 `WeakMap<host, Map<key, KeySubscription>>`；两个 outlet 都从中读取订阅对，因此 subscribe 和 `getSnapshot` 函数会在渲染间保持身份，React 也会保留订阅。

**检查点化解析，并将未稳定的尾部作为文本渲染。** 增量解析器使用带 UTF-8 计数的 8 KiB 检查点，保留 `checkpointTail`，并将最新后缀作为 `plainTextBlock` 发出——代码明确写道，最新后缀在检查点或结算覆盖它之前“按纯文本渲染”。`settle()` 执行完整解析，并根据采样前缀对其进行验证，因此结算后的 DOM 与非增量解析产生的结果完全一致。

**推进流程模型，而不是重建它。** `AgentFlowView` 会在渲染之间保留 builder；builder 保留 lineage 选择、行缓存、已验证的地址读取，以及针对后代/token 聚合的 gate；子节点连接使用 `Map` 而不是 `find`。折叠的子树仍会贡献其聚合值，但不会具体化可见行。一次性构建仍是一个薄封装，因此需要单个快照的调用者无需改变。

## 备选方案

**使用 `useCallback` 记忆化 outlet 闭包。** 拒绝：身份必须按*host 和 key*稳定，而不是按组件实例稳定——同一 key 上的兄弟 outlet 应共享一个订阅，重新挂载的组件也不应使其成为孤立订阅。WeakMap 以 host 为键，因此缓存会随 host 一同消失。

**只在结算时解析，流式期间显示原始文本。** 拒绝：这会使每个流式回复在整个生命周期内都没有格式化，是为了换取一个检查点已经限制的成本而引入的可见回归。

**从上一个块边界重新解析，而不是使用字节检查点。** 拒绝：块边界只有在语法结算后才能确定，而这正是被推迟的事情；带 UTF-8 计数的字节检查点无需理解后续内容即可成为解析器能够取得的上限。

**保留整体构建的 AgentFlow，并记忆化其结果。** 拒绝：记忆化整体构建仍会在任何输入移动时支付构建成本，而对于活动 swarm 来说输入会持续移动。

## 影响

Outlet 订阅现在在其 host 的生命周期内保持稳定，内部 key 命名空间受 host 声明的 slots 数量限制。流式消息可能会在下一个检查点之前将其最新后缀作为纯文本渲染，随后才显示格式；结算后的 DOM 已验证与完整解析一致，因此最终不会丢失内容。流程 builder 按视图缓存，并依赖引用稳定的 lineage，而运行时的身份工作提供了这一点；其地址读取经过验证而不是被假定。新的 spec 覆盖了宽扇出、深链、折叠子树、快速路径/地址和行转换场景，这些正是基于扫描的连接过去会失败的场景。

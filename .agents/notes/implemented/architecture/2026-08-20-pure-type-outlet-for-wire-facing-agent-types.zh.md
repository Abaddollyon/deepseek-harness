# Agent Note: Wire-facing agent types live in the pure-type outlet

Status: implemented

[English](2026-08-20-pure-type-outlet-for-wire-facing-agent-types.md) | 中文

## 问题

`AgentActivity`——会话状态帧携带的实时限定符——原本声明在 `dsh-agent/runtime-types.ts` 中,该模块同时声明了 `Agent` 接口以及针对每个 agent 主题事件的 `Events` 声明合并。

客户端聚合随之无法通过类型检查。客户端包需要该*值联合*来渲染停止控件,但从运行时模块导入它会把宿主 `Context` 合并拖进客户端程序——而仓库的编译器布局存在的目的恰恰是让宿主与客户端的 cordis `Context` 合并永远不会在同一个 `ts.Program` 中相遇。类型本身没错;错的是它的地址。

## 决策

`AgentActivity` 声明在 `packages/core/agent/src/types.ts`——该包的纯类型模块(`src/types.ts` 只包含类型,没有运行时代码)——并从 `runtime-types.ts` 重新导出,使所有现有宿主导入方保持不变。该包已将该模块作为自身的 `./types` 导出条件发布,因此客户端包通过一个不携带任何服务声明、任何 `Events` 合并、任何 `Context` 增强的出口导入这个联合类型。

## 备选方案

**在客户端包中复制该联合类型。** 已否决:同一 wire 词汇的两份声明会在第一次新增值时发生漂移,并且宿主没有任何编译期信号表明客户端的副本已不再匹配它发送的内容。

**从渲染它的客户端包重新导出。** 已否决:重新导出链仍会通过宿主模块解析,合并仍会落入客户端程序——这正是本次变更要消除的失败模式。

**在 wire 边界把帧字段放宽为 `string`。** 已否决:该字段是宿主拥有的封闭词汇,将其抹平为 `string` 会把编译器正在执行的穷尽性检查变成一个没人会写的运行时分支。

## 影响

跨越宿主/客户端 wire 的类型属于纯类型出口,而不是产生它的服务旁边——这是本次变更所体现的一般规则,下一个面向 wire 的词汇应当直接在那里声明。宿主导入方不受影响:`runtime-types.ts` 重新导出该联合,因此 `import type { AgentActivity } from '@deepseek-ai/dsh-agent'` 仍然可以解析。这次拆分的成本是一行重新导出,却消除了一整类只有当客户端包最终消费该词汇时才会出现的聚合类型检查失败。

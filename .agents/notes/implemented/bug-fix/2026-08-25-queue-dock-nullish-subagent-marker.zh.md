# Agent Note: Queue dock 将缺失的 subagent 标记视为普通会话

Status: implemented

[English](2026-08-25-queue-dock-nullish-subagent-marker.md) | 中文

## Problem

QueueDock 依据会话快照中的已寻址 subagent 标记决定是否提供排队行的编辑、移除与插话操作：普通会话保留这些操作，已寻址 subagent 则没有，因为其继续执行传输不提供 Queue 变更。写成 `s.subagent === null` 的门禁会把缺失标记（`undefined`）的快照当作 subagent，从而隐藏这些操作。在 lint 清理中，容忍写法 `=== null || === undefined` 又与 `no-unnecessary-condition` 冲突：`ConversationSnapshot.subagent` 声明为 `{ address, parentAvailable } | null`，且其唯一生产者 `Session.buildSnapshot()` 总是写入该字段，因此 `undefined` 分支与声明类型没有交集。

## Decision

声明类型保持权威：该字段自引入以来就是必填的 `| null`，`Session.buildSnapshot()` 是唯一的快照生产者，且不存在任何会从持久化或链路重建快照的路径。QueueDock 以惯用的空值合并比较 `s.subagent == null` 保留容忍读取，既覆盖 `null` 也覆盖缺失的标记，又无需压制规则，与 InputBar 中 `goal != null` 的先例一致。构造缺失标记快照的回归测试继续钉住这项容忍：一旦简化回严格的 `=== null`，测试即失败。

## Alternatives considered

**把 `ConversationSnapshot` 中的 `subagent` 改为可选。** 拒绝，因为没有任何生产者会省略该字段；为了描述一个从不出现的状态而放宽快照契约，会削弱所有消费方的类型保障。

**删除 `undefined` 分支及其回归测试。** 拒绝，因为该测试钉住的是刻意的容忍行为；二者都删会让未来任何向 `=== null` 的“简化”在毫无信号的情况下重新引入操作被隐藏的故障。

**在该处禁用 `no-unnecessary-condition`。** 依据窄化例外原则拒绝；`== null` 无需压制即可表达相同行为。

## Testing

`packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` 驱动一个 `subagent` 为 `undefined` 的实时快照，确认编辑入口仍然可用；已寻址 subagent 的情形则保持操作隐藏。

## Consequences

行为保留的同时 lint 保持干净，组件注释记录了为何刻意使用空值比较。这项容忍的代价是一个不显眼的惯用写法，而构造的测试夹具仍是缺失标记唯一存在的地方——沿生产路径追溯的读者会发现该字段始终存在。

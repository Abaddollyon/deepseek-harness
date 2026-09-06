---
description: "无内容 Host 注册表，供被动状态消费方观察当前审批与提问生命周期，而无需加入 answerer waterfall。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pending-interactions

[English](README.md) | 中文

## 概述

`dsh-pending-interactions` 定义 `ctx.pendingInteractions`，这是一个 Host 注册表，暴露哪些审批、提问或计划审阅请求正在等待人类。它只携带身份与生命周期：请求文本、工具参数、回答回调、waterfall continuation 和结果都不会进入此服务。

## 目录

- [服务：`PendingInteractionRegistry`（ctx 键：`pendingInteractions`）](#service-pendinginteractionregistry-ctx-key-pendinginteractions)
- [生命周期](#lifecycle)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service-pendinginteractionregistry-ctx-key-pendinginteractions"></a>
## 服务：`PendingInteractionRegistry`（ctx 键：`pendingInteractions`）

### 公开 API

- `begin({ kind, agent? }): () => void` 记录一个待处理交互，并返回其幂等结束能力。
- `snapshot(): PendingInteractionSnapshot` 返回本次激活 epoch、当前 revision 与待处理记录。
- `onChange(listener): () => void` 观察未来带 revision 的开始／结束变化，并返回取消订阅能力。

`PendingInteractionObserver` 是供状态消费方使用的只读 `snapshot()` 加 `onChange()` 接口。记录只包含不透明 `id`、`kind`、可选 `agentId` 与 `sessionId`，以及 `startedAtMs`；结束变化另含 `endedAtMs`。Host 服务重新挂载时 epoch 会改变，revision 在同一 epoch 内递增。

<a id="lifecycle"></a>
## 生命周期

审批与用户提问服务只在实际派发给 answerer 时调用 `begin()`。它们在回答、拒绝、提供方不可用、错误或取消时结束记录。注册表还会在 `agent/disposed` 时清除该 agent 的记录，并在自身 dispose（资源释放）时清除所有记录。观察者交付通过队列执行且隔离失败，因此观察者无法回答、延迟或替换交互结果。

<a id="model-experience"></a>
## 模型体验

无，因为注册表只向被动 Host 消费方暴露进程内生命周期元数据。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **仅限进程内生命周期**：重连的消费方从当前快照开始；已结束记录不是持久历史。
- **无 agent 的提问没有会话身份**：它们仍可通过不透明 id 与 kind 被观察，但不存在可用于推导 agent 或会话身份的存活 Agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

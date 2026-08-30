# Agent Note: 结算通知只转述 child 的收尾文本

Status: implemented

[English](2026-08-25-subagent-settlement-notice-text-only.md) | 中文

## 问题

[管理器所有的结算投递](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)会把结算 child 的最终 assistant 消息回显进一条发给父级的用户角色通知。终端输出是那条消息的原文，因此推理模型的收尾消息会把它的推理（reasoning）块一并带上：child 的私人思考以用户消息内容的形式进入父级上下文；而在 token 上限处被截断、思考说到一半的 child，会留给父级一个悬空的 `Its closing message:` 标题，下面跟着父级本不该看到的推理内容。

## 决策

`notifySettlement()` 在构造父级通知之前，立即将终端输出过滤为文本块。内容中不含文本的收尾消息按没有收尾消息处理，因此既有的 `It left no closing message.` 回退同时覆盖「child 什么也没有产出」和「最终消息只有推理」两种情形。收窄的只有面向父级的回显：`subagent/end.lastAssistantMessage` 仍为遥测与 UI 消费方携带完整的最终内容，child 自己的会话日志也不受影响。

## 考虑过备选方案

**在输出选择处（`finalAssistantOutput`）过滤。** 该选择同时供给 `subagent/end.lastAssistantMessage` 与后端运行结果，那里完整消息才是契约；在那里收窄会把推理内容从合法观察它的遥测中剥掉。

**给推理内容单设一个标签转述。** 单独的段落仍然会把 child 的私人思考纳入父级上下文，并为 child 从未选择作为输出的内容消耗父级 token；report 工具才是 child 自主选择分享内容的通道。

**只转述结果句。** 已与[管理器所有的结算投递](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)一同否决：当 child 从未上报时，收尾消息正是父级据以行动的那份记账。

## 后果

- 推理模型的结算通知在父级上下文中只消耗可见回答的 token。
- 单元覆盖固定了两种形态：推理与文本混合的收尾消息只贡献文本，纯推理的收尾消息按没有收尾消息处理。

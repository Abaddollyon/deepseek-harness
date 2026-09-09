---
description: "dsh Web 客户端的持久化工作流运行 Conversation Node：把工作流运行重建为带嵌套成员折叠的独立聊天节点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workflow-run

[English](README.md) | 中文

## 概述

使用 `dsh-client-ui-workflow-run` 可以把持久化工作流运行作为独立 Chat 节点查看。展开运行查看阶段，展开阶段查看成员；运行中、失败、已取消与已中断的层级默认展开，已完成层级保持折叠。只要普通 Session 列表将子 Session 标识为当前 Session 的 child，成员就能打开它，包括结算之后。投影保留阶段标题与持久化叙述，但面板只显示名称、成员数与状态。需要查看进度和导航到子级时选择本包；它不展示脚本、输出、错误、日志、用量、静态拓扑或执行控制。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

经 `dsh-tool-workflow` 记录的工作流运行会在对话中显示为独立节点：展开运行查看其阶段，展开阶段查看其成员。Definition 不排除带 `parentCallId` 的运行。不同的已记录阶段标题按首次出现顺序建立阶段组，包括没有成员的阶段；成员开始事件随后按成员顺序补入缺少的阶段组。未提供的阶段身份与空字符串阶段身份保持区分；成员结算只改变状态，不删除或重排成员。只要子 id 位于普通 Session 列表、列表行为 `origin: 'subagent'` 且 `parentId` 等于当前 Session，成员即可打开其子 Session。结算不会撤销这一点：完成或已中断的成员在其子行仍存在时保持可打开，因为 `sessions.open(id)` 对已结束的子级同样有效。带下划线的成员文字是唯一可见导航提示；键盘聚焦时，名称区显示 2 像素 business-primary 焦点环，右侧状态仍只显示生命周期词。组件只调用注入的普通 `sessions.open(id)`；普通列表中不存在其子 Session 的行（远程、仅地址化或父级不符）都不可交互。

### 导航节点

运行使用 32 像素行，带常驻 chevron、行内状态点与状态文字；阶段使用 disclosure 行，在主区显示标题与成员数、在固定尾部显示聚合状态；成员使用 16 像素状态点槽、可省略名称区与固定状态列。打开成员的子 Session 需要子 id 位于普通 Session 列表、列表行为 `origin: 'subagent'` 且 `parentId` 等于当前 Session——远程、仅地址化、父级不符或不存在的行都不可交互；只要子行存在，结算不会撤销导航。

### 状态与完成

完成状态会立即更新，但只要焦点仍位于展开内容内，自动折叠就会等待焦点离开。若所属 Turn 或 Step 已关闭但终点事件缺失，界面把相应运行或成员显示为已中断，而不改写工具结果。已分离的运行在起始 Step 关闭后仍显示为运行中，因为后续终点事件由监督器负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

节点确定性回放六类持久化 `tool-workflow/*` 事件：`run-start` 以 `runId` 创建唯一 Context；`phase`、`log`、`agent-start`、`agent-end` 和 `run-end` 按日志顺序更新它。带 `runId` 的工作流 `run/detached` 也更新该 Context。阶段标题建立阶段组；日志在投影的 `narration` 数组中保留 `message`、`ordinal` 和可选的 `truncated`，未捕获日志的旧记录省略该数组。`WorkflowRunPanel` 不渲染这些叙述。只有 update 的历史尾页会保持 pending，直到更早页面补入唯一 start；此后 prepend、完整回放与实时 append 得到相同状态。

### 展开选择

普通运行更新保留当前选择，首次异常边沿只自动展开一次，正常完成只自动折叠一次；已完成阶段在同一 phase key 下开始新的运行成员时，该 Phase 与外层运行会再次自动展开。若一个完整的新干净周期在同一次渲染中送达且运行仍处于活动状态，Phase 保持折叠，但外层运行会自动展开一次以展示更新后的摘要。Phase 选择由 `WorkflowRunPanel` 持有，因此关闭并重新打开外层运行不会重置它们；renderer remount 会从持久事实重建每层的初始选择。

### 装配

本包把 Definition、locale 字典与 `workflow-run` renderer 都注册为 Cordis effect；移除客户端 entry 会撤销三者。shipped Web bundle 在 `ui-conversation` 与 `ui-tool` 之后装配该插件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖工具 seam、对话宿主与工具展示层。

- [tool-workflow](../../workflow/tool-workflow/README.zh.md)——拥有本包折叠的六类 `tool-workflow/*` Session 事件的工具。
- [ui-conversation](../ui-conversation/README.zh.md)——承载 `conversation.chat.node` slot 的聊天界面。
- [ui-tool](../ui-tool/README.zh.md)——本节点相邻的工具调用展示层。
- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md)——业务自有功能如何注册 Conversation node。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，只渲染持久化工作流记录，不改变模型上下文。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义哪些运行会产生记录、节点暴露什么；它们是当前包约束。

- **必须有持久化工作流记录**：Definition 接受已记录的运行，不过滤 `parentCallId`，但无法重建未发出匹配 `tool-workflow/*` 事件的执行；只有 update 时，必须等匹配的 `run-start` 可用后才产生可见节点。
- **导航跟随普通 Session 列表**：成员结算后只要其子行仍在列表中就保持可打开；但列表不包含其子 Session 的成员（例如远程行）永不从本节点提供打开入口。
- **面板显示名称、成员数与状态**：持久化叙述保留在节点数据中，但不显示；脚本、输出、错误详情、用量、静态拓扑与执行控制也不属于该面板。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。浏览器插件只贡献 effect 所有的 Conversation Definition、keyed renderer 与 dictionary；Host tool 包负责持久事件不变式。

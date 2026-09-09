---
description: "为独立 Host context、复合 Session identity、持久环境导航和 generation 绑定功能请求提供浏览器 runtime owner。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-environment-runtime

[English](README.md) | 中文

## 概述

用户可以在本地与远端 Host Session 之间切换，而不会混用草稿、视图、侧边栏状态或请求。导航在 UI 重新挂载后保留，重新连接也会保留选中的 presentation。集成方可以等待目标连接就绪，并拒绝来自已被替代 Host generation 的结果。浏览器持久化在固定限额内保留最近的呈现状态；远端功能请求必须使用已注册路由。

## 目录

- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包拥有浏览器 shell 的本地环境 identity、持久环境导航、复合 Host/Session presentation state，以及独立获取的 Host runtime 生命周期。每个远端 runtime 都获得新的 Cordis root、由自身 carrier transport 创建的显式 Connection 和 dependency-closed domain roster。选中 runtime 的 presentation plugin 使用该 runtime 自有的 service，同时共享 shell 中唯一的 renderer、layout、locale 和 Slot registry。

Runtime request service 只接受已注册的相对 `/api/` 路由。每次调用都绑定一个环境；当 Connection generation 变化或消失后，调用结果会被拒绝。活跃 composition snapshot 会在保持 runtime 已挂载的同时报告 `connecting`、`connected` 或 `disconnected`，记录最后连接时间，并在不改变导航的情况下重试同一个 Connection。Registry 共享同一环境的并发获取，并在最后一个 lease 释放后处置 runtime 与 carrier。

应用 shell 在完整生命周期内拥有 `ctx.environmentNavigation`。在 Environments overview 中选择 Host card 时仍使用本地 control plane；只有导航打开该 Host 的 Session 时才会获取远端 runtime。需要在目标 presentation 上执行操作的 shell integration 使用 `ctx.environmentComposition.withPresentation(location, callback, { signal })`。它会等待精确的远端 presentation 与已连接 generation，或等待恢复后的本地 shell；随后把目标 context 与组合生命周期 signal 传给 callback，并且只有同一 navigation intent、runtime 与 generation 仍为当前值时才确认结果。有界 presentation store 会为 Host-local id 相同的 Session 分隔 draft、view、detail、scroll 与 sidebar state。浏览器持久化会在状态静止 250 ms 后写入，在 page hide 或 runtime 销毁时刷新待写状态，忽略 storage 权限和配额失败，并按最新 Session 优先的顺序把序列化结果限制在一百万个 UTF-16 code unit 内。内存状态仍立即更新，并保留持久化 snapshot 因限额省略的旧条目。Slot component 与 Host API 仍接收原生 Session id；只有 renderer Store cache 与持久化使用复合 identity。切换 Host 时可以撤下 UI registration package，而不会拆除 navigation 或 composition coordinator；renderer 会保留最后一组 root standard source 与 scope adapter，直到替代者完成安装。

Runtime projection 与 package 所有权见 [Web Client 架构](../../../docs/subsystems/web-client.zh.md)。

Shell location 包含带 Host 身份的空白 `new-session` 会话。显式工作区操作即使没有改变当前 Session id，也会发布导航；`backToSession()` 返回最近打开的会话，`canBackToSession()` 表示该目标是否可用。共享侧边栏查询由 presentation state 持有。固定会话读取现有 Host 工作区视图 store，尚未挂载的 Host 则读取其持久化数据；不会再序列化一套固定状态。固定状态订阅随 UI 注册释放，保留的 presentation source 随 shell 释放，不同 Host 上相同的 Session id 仍彼此独立。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无。本包路由浏览器状态与 Host 请求，不组装模型输入。

#### KV Cache 影响

无；环境选择、presentation state 与 transport generation 不改变 provider request。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一个 carrier factory 覆盖整个 shell 生命周期** — environment composition 活跃时，产品 composition 不能替换 transport authority。
- **功能路由必须显式注册** — runtime plugin 不能通过 environment request service 发起任意绝对地址或未注册的网络请求。
- **Presentation 内存最多保留 200 个 Session** — 超过限制时会淘汰最早的非活跃复合 Session state；更小的序列化存储上限可能在重载后保留较少条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

将 runtime-owned service 置于各 environment root 之下，并将 shell-owned renderer、layout、locale 与 navigation service 保持在这些 root 之上。Host 切换必须先退役旧 presentation，再公开替代 runtime 的 service。

`withPresentation` callback 应保持短生命周期，并把其收到的 signal 传入目标请求。调用方取消或 deadline、导航被替代以及 composition 销毁都会中止该 signal。忽略 signal 的操作可能在内部完成，但其结果无法通过 coordinator 的最终确认 fence。

</details>

**Runtime invariant：** 不发布 companion。由驱动生命周期 spec 直接验证 runtime identity、route authorization、generation fencing、lease disposal 与 Loader-owned projection。

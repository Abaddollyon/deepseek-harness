---
description: "为独立 Host context、复合 Session identity、持久环境导航和 generation 绑定功能请求提供浏览器 runtime owner。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-environment-runtime

[English](README.md) | 中文

## 摘要

本包拥有浏览器 shell 的本地环境 identity、持久环境导航、复合 Host/Session presentation state，以及独立获取的 Host runtime 生命周期。每个远端 runtime 都获得新的 Cordis root、由自身 carrier transport 创建的显式 Connection 和 dependency-closed domain roster。选中 runtime 的 presentation plugin 使用该 runtime 自有的 service，同时共享 shell 中唯一的 renderer、layout、locale 和 Slot registry。

Runtime request service 只接受已注册的相对 `/api/` 路由。每次调用都绑定一个环境；当 Connection generation 变化或消失后，调用结果会被拒绝。活跃 composition snapshot 会在保持 runtime 已挂载的同时报告 `connecting`、`connected` 或 `disconnected`，记录最后连接时间，并在不改变导航的情况下重试同一个 Connection。Registry 共享同一环境的并发获取，并在最后一个 lease 释放后处置 runtime 与 carrier。

应用 shell 在完整生命周期内拥有 `ctx.environmentNavigation`。在 Environments overview 中选择 Host card 时仍使用本地 control plane；只有导航打开该 Host 的 Session 时才会获取远端 runtime。有界 presentation store 会为 Host-local id 相同的 Session 分隔 draft、view、detail、scroll 与 sidebar state。Slot component 与 Host API 仍接收原生 Session id；只有 renderer Store cache 与持久化使用复合 identity。切换 Host 时可以撤下 UI registration package，而不会拆除导航或 composition coordinator；renderer 会保留最后一组 root standard source 与 scope adapter，直到替代者完成安装。

Runtime projection 与 package 所有权见 [Web Client 架构](../../../docs/subsystems/web-client.zh.md)。

## 模型体验

无。本包路由浏览器状态与 Host 请求，不组装模型输入。

#### KV Cache 影响

无；环境选择、presentation state 与 transport generation 不改变 provider request。

## 已知限制与延期工作

- **一个 carrier factory 覆盖整个 shell 生命周期** — environment composition 活跃时，产品 composition 不能替换 transport authority。
- **功能路由必须显式注册** — runtime plugin 不能通过 environment request service 发起任意绝对地址或未注册的网络请求。
- **Presentation 持久化最多保留 200 个 Session** — 超过限制时会淘汰最早的非活跃复合 Session state。

**Runtime invariant：** 不发布 companion。由驱动生命周期 spec 直接验证 runtime identity、route authorization、generation fencing、lease disposal 与 Loader-owned projection。

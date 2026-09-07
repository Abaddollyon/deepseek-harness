---
description: "为持久 Web shell 提供环境总览、Activity sidebar 切换与导航操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-environment-navigation

[English](README.md) | 中文

## 概述

这个浏览器 UI plugin 渲染 Environments overview seat、现有浏览区上方带标签的 Workspaces 与 Activity 控件、现有浏览区中的 Activity 内容，以及底部 server 操作。它消费 `environment-runtime` 提供的持久 `ctx.environmentNavigation` service；处置本 plugin 只移除自己的 Slot registration 与订阅，因此选中 location 和复合 presentation state 能跨 Host 切换与 UI remount 保留。

Overview 在 `active.content` 中渲染，并保留共享 sidebar 与 renderer。产品 package 通过 `environment.overview.content` 和 `sidebar.activity` 填充环境清单与活动 row。Sidebar mode 按 Host 分别存储。展开时显示两个名称；收起栏提供分别标注的图标与明确的选中状态。Activity 隐藏工作区专属控件，并将共享查询应用于自己的行。

环境 runtime projection 见 [Web Client 架构](../../../docs/subsystems/web-client.zh.md)，注册规则见 [Web Client Slots](../../../docs/subsystems/slots.zh.md)。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无。本包渲染浏览器导航，不注册任何模型侧功能。

#### KV Cache 影响

无；导航与 sidebar state 不组装或发送 provider request。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **本包不发现环境** — 产品 plugin 必须填充 `environment.overview.content`。
- **本包不推导 Activity row** — activity provider 拥有 `sidebar.activity` 内容及其数据源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

将环境 inventory 与 activity policy 保留在产品 package 中。本包只负责持久 shell navigation seat 与 Host-scoped sidebar state。

</details>

**Runtime invariant：** 不发布 companion。由 component 与 Loader lifecycle spec 直接验证 Slot registration disposal、稳定导航所有权与 Host-scoped sidebar state。

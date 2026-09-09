---
description: "为持久 Web shell 提供环境总览、Activity sidebar 切换与导航操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-environment-navigation

[English](README.md) | 中文

## 概述

用户可以通过底部 server 操作打开 Environments 总览，并在现有侧边栏中切换 Workspaces 与 Activity。每个 Host 分别保留自己的侧边栏模式。展开时显示两个名称；收起栏提供带标签的图标与明确的选中状态。Activity 隐藏工作区专属控件，并将共享搜索查询应用于自己的行。选中的位置与呈现状态在 Host 切换和 UI 重新挂载后保留。产品插件提供环境清单与 Activity 行。

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

本插件消费 `environment-runtime` 提供的持久 `ctx.environmentNavigation` service。处置时只移除自己的 Slot registration 与订阅，保留选中的 location 和复合 presentation state。Workspaces 与 Activity 控件位于现有浏览区上方，Activity 使用现有浏览区的内容区域。

Overview 在 `active.content` 中渲染，并保留共享 sidebar 与 renderer。产品 package 通过 `environment.overview.content` 和 `sidebar.activity` 填充环境清单与活动 row。

环境 runtime projection 见 [Web Client 架构](../../../docs/subsystems/web-client.zh.md)，注册规则见 [Web Client Slots](../../../docs/subsystems/slots.zh.md)。

</details>

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

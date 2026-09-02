# Agent Note: Sidebar workspace section slot

Status: implemented

[English](2026-08-23-sidebar-workspace-section-slot.md) | 中文

## Problem

侧边栏把浏览区域的独占所有权交给了 ui-workspace。远程 SSH 插件需要一个与 Workspace 相邻的导航分区，但为每个域修改外壳会把可选集成耦合到核心 UI 内部。

## Decision

ui-sidebar 声明根作用域 list slot sidebar.workspace.section，并在单一的 sidebar.workspaces 浏览器 seat 之前渲染它。每个条目只接收 SidebarSectionOwnerProps：当前宽栏／轨道状态和展开请求。外部包使用 slots.inject() 等待声明并注册自己的条目，因此贡献遵循侧边栏声明和插件 fiber 生命周期。

## Alternatives considered

**替换 sidebar.workspaces。** 不采用，因为 Workspace 浏览器持有搜索、Session 行和对话框；远程集成不应接管该产品域。

**添加一个远程 SSH 专用的侧边栏 API。** 不采用，因为侧边栏位置是通用的；多个可选的 Workspace 相邻域都可以使用这个有序 list，而不必导入远程服务。

## Consequences

外壳只持有一个小型有序插入点，不持有远程状态。分区占用者必须提供自己的紧凑轨道呈现和业务数据。sidebar.workspaces 保持为单一浏览器 seat。

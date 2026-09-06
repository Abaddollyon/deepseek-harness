---
description: "供应用内客户端使用、无需显示界面的主机目录浏览接缝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser

[English](README.md) | 中文

## 概述

`dsh-host-directory-browser` 定义始终可寻址的主机能力 `ctx.directoryBrowser`，用于有界目录列表和创建子目录。它独立于 `ctx.directoryPicker`：主机可为本地窗口保留原生系统选择器，同时让远程客户端浏览同一主机文件系统，且不打开主机界面。

## 使用此包

提供方继承 `DirectoryBrowser` 并实现 `list(path?, signal?)` 与 `createDirectory(path, name)`。消费方注入 `directoryBrowser`；工作区控制器通过 `directoryBrowser/list` 和 `directoryBrowser/createDirectory` Remote 方法公开它。

列表与错误值类型继续与旧的 directory-picker browse 能力共享，因此现有客户端迁移时无需引入第二套线协议词汇。

## 延伸阅读

- [文件系统提供方](../directory-browser-filesystem/README.zh.md)
- [目录选择器接缝](../directory-picker/README.zh.md)
- [工作区控制器](../../api/workspace-controller/README.zh.md)

## 模型体验

无。该服务是 GUI 主机能力，不公开模型工具或提示内容。

#### KV 缓存影响

无；此包不组装提供方请求。

## 已知限制与延期工作

此包只定义能力。文件系统策略、边界和平台行为属于所选提供方。

### 开发说明

保持该服务与交互式选择器独立。即使 `ctx.directoryPicker` 提供原生选择器，远程浏览也必须可用。

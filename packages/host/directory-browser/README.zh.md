---
description: "供应用内客户端使用、无需显示界面的主机目录浏览接缝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser

[English](README.md) | 中文

## 概述

`dsh-host-directory-browser` 定义始终可寻址的主机能力 `ctx.directoryBrowser`，用于有界目录列表和创建子目录。它独立于 `ctx.directoryPicker`：主机可为本地窗口保留原生系统选择器，同时让远程客户端浏览同一主机文件系统，且不打开主机界面。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 使用此包

提供方继承 `DirectoryBrowser` 并实现 `list(path?, signal?)` 与 `createDirectory(path, name)`。消费方注入 `directoryBrowser`；工作区控制器通过 `directoryBrowser/list` 和 `directoryBrowser/createDirectory` Remote 方法公开它。

列表与错误值类型继续与旧的 directory-picker browse 能力共享，因此现有客户端迁移时无需引入第二套线协议词汇。

## 延伸阅读

- [文件系统提供方](../directory-browser-filesystem/README.zh.md)
- [目录选择器接缝](../directory-picker/README.zh.md)
- [工作区控制器](../../api/workspace-controller/README.zh.md)

<a id="model-experience"></a>
## 模型体验

无，因为这个无显示界面的 GUI 主机浏览 seam 不注册任何面向模型的内容。

#### KV 缓存影响

无；此包不组装提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Seam 不定义文件系统策略**——边界、根目录、符号链接处理和平台行为属于所选提供方。

<a id="dev-note"></a>
### 开发备注

保持该服务与交互式选择器独立。即使 `ctx.directoryPicker` 提供原生选择器，远程浏览也必须可用。

不发布运行时不变式 companion；此 Service Definition 只持有不可变的请求与结果类型，全部可变文件系统观察均由所选提供方持有。

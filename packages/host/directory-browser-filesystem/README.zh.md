---
description: "供无需显示界面的主机目录浏览器使用的有界本地文件系统提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser-filesystem

[English](README.md) | 中文

## 概述

此包通过主机文件系统提供 `ctx.directoryBrowser`。它以有界排序窗口流式读取单层目录，跟随指向目录的符号链接，跳过非目录行，并创建一个经验证的子目录，全程不打开操作系统界面。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 使用此包

组合一个名为 `@deepseek-ai/dsh-host-directory-browser-filesystem` 的配置行。`list(path?)` 默认读取主机账户的主目录，并返回绝对条目路径、祖先面包屑、隐藏标记和 `truncated`。`createDirectory(path, name)` 要求完全限定的父路径和一个非空路径段。

`maxEntries` 默认为 1,000。相对路径和 Windows 驱动器相对形式会被拒绝，不会依据进程状态解析。调用方取消会与每个文件系统等待竞争。

## 延伸阅读

- [目录浏览器接缝](../directory-browser/README.zh.md)
- [旧 browse 适配器](../directory-picker-browse/README.zh.md)
- [目录选择器架构决策](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md)

<a id="model-experience"></a>
## 模型体验

无，因为这个 GUI 主机文件系统浏览器不注册任何面向模型的内容。

#### KV 缓存影响

无；此包不组装提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **平台元数据有限**——Node dirent 不提供 Windows 隐藏属性，也不枚举驱动器根目录。
- **浏览范围覆盖整个文件系统**——Workspace API 仍负责决定哪个已选路径成为工作区。

<a id="dev-note"></a>
### 开发备注

保持列表内存有界并保留完全限定路径防线。提供方绝不能调用操作系统选择器。

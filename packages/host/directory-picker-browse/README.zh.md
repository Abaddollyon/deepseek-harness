---
description: "把独立主机目录浏览器公开为 directory-picker browse 能力的兼容适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-browse

[English](README.md) | 中文

## 概述

`dsh-host-directory-picker-browse` 把独立的 `ctx.directoryBrowser` 服务适配为旧的 `ctx.directoryPicker` browse 能力。它保持现有应用内选择器界面兼容，同时把文件系统所有权放在始终可用的浏览提供方中。

## 使用此包

先组合一个 `directoryBrowser` 提供方，再组合此适配器。适配器注入该服务并返回稳定的 `{ kind: 'browse', list, createDirectory }` 能力。它没有配置，也不自行执行文件系统操作。

选择原生 picker 的主机无需使用此适配器来进行远程浏览：`ctx.directoryBrowser` 与 `directoryBrowser/*` Remote 命名空间仍独立可用。

## 延伸阅读

- [目录浏览器接缝](../directory-browser/README.zh.md)
- [文件系统提供方](../directory-browser-filesystem/README.zh.md)
- [原生 picker](../directory-picker-native/README.zh.md)
- [自适应 picker](../directory-picker-auto/README.zh.md)

## 模型体验

无。此包只适配 GUI 主机能力。

#### KV 缓存影响

无；此包不组装提供方请求。

## 已知限制与延期工作

适配器要求恰好一个 `ctx.directoryBrowser` 提供方。其 browse 合同为兼容性保留 directory-picker 错误词汇。

### 开发说明

不要把文件系统代码移回此适配器。独立浏览器使远程客户端可在本地原生选择器保持组合时继续浏览。

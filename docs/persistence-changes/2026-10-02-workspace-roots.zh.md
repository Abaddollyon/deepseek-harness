---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-workspace-roots

[English](2026-10-02-workspace-roots.md) | 中文

## 概述

新增 workspace/roots 事件，记录 Session 在其 header cwd 之外可以使用的附加目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-workspace-roots
baseline: false
changes:
  - root: "event:workspace/roots"
    previous: null
    after: "1c875e99ac34f443149f4787f2c7dd160981ad48b09c98e18cc5737ae5c02fad"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有日志不含该事件，读取时仍视为没有附加根目录。写入方只在 seq 0 记录它并带有 ignorable: true，因此较旧的读取方会跳过它，并把 Session 限制在 cwd 内；模型可见的沙箱策略文本另行作为运行时上下文记录，跳过该事件不会改变已记录历史的回放。Session header 与事件信封均未改变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/session/tests/workspace-roots.spec.ts：3 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。

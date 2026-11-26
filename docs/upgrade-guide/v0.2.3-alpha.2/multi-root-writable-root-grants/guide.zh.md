---
kind: upgrade-guide
description: "Session 的附加工作区根目录改为按 Agent 授予的可写根目录：resolve() 只在 Session 上有 Agent 运行时报告它们，策略文本只在 workspace-write 模式下列出它们。"
---

# 附加工作区根目录按 Agent 授予

[English](guide.md) | 中文

## 变更

多根 Session 仍把其附加目录记录为 seq 0 的 `workspace/roots` 事件，Workspace 仍会把 `additionalPaths` 传给新 Session。变化在于执行限制。

在上一个 fork 版本中，`ctx.sandboxPolicy.resolve({ session })` 每次调用都读取 `session.additionalPaths`，并把它们排在 `additionalWritableRoots` 的最前面，之后才是配置的额外目录。模型可见的策略文本在每种模式下都列出“Workspace roots for this session”。

现在，`agent/created` 宣告该 Session 上的 Agent 时，`SandboxPolicyService` 会以 `registerWritableRoot` 注册每个已记录的根目录，有效期为该 Agent 的生命周期，并且每次启动都会注册：启动、恢复、clear 与 compact。`resolve()` 先报告配置的额外目录，再报告已注册的根目录。没有存活 Agent 的 Session 不获得授权。在 Agent 执行世界中已不再是目录或无法检查的根目录会被跳过并记录一条 `sandbox-policy` 警告，而不是让每次写入失败。策略文本只在 workspace-write 模式下把这些根目录列为“Additional writable directories”；read-only 与 danger-full-access 的文本不再提及它们。在 Windows 上，这些授权作用于文件工具，而不作用于沙箱进程。

受影响的有：为没有存活 Agent 的 Session 调用 `resolve()` 的代码、依赖 `additionalWritableRoots` 顺序的代码，以及包含多根策略文本的 recorded-session 快照。`CreateSessionOptions.meta` 现在的类型是 `SessionCreationMeta`，它在 `SessionHeaderMeta` 上增加 `additionalPaths`；现有创建调用无需修改即可编译。

## 迁移

1. 只在多根 Session 的 Agent 创建之后为其解析策略，例如在 `agent/created` 监听器内（沙箱策略会把自己的监听器排在前面），或在运行中 Agent 的工具调用中。要在没有 Agent 时授予目录，调用 `ctx.sandboxPolicy.registerWritableRoot(session, directory)`，并在授权结束时调用返回的清理函数。
2. 把 `additionalWritableRoots` 作为集合比较，而不是按位置比较。
3. 重新创建已被删除的已记录根目录，或启动一个不含它的 Session；警告会注明该 Session 与被跳过的路径。
4. 重新录制系统提示词中包含多根策略文本的快照。
5. 确认迁移：以 workspace-write 模式恢复一个多根 Session，在某个附加根目录下写入一个文件，并检查策略文本列出了该根目录。

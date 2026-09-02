# Agent Note：在 pwsh 回退预算中保留完整 marker 框架

Status: implemented

[English](2026-08-30-pwsh-fallback-marker-framing.md) | 中文

## 问题

持久化 pwsh 工具累积增量回退缓冲，以便在保留的滚动区无法回答时保留部分诊断：START marker 丢失、读取撕裂或 shell 在捕获期间退出。该缓冲的上限在移除回显包装器后按 maxOutputChars 加一个可打印提示符计算，但没有为它需要保护的框架预留空间。真实 START marker 本身就有 66 个字符，而轮询增量还可能在包装命令两侧携带 prompt 函数的 OSC 133;D 输出，因此较小的 maxOutputChars 会在 partialOutput 执行前截断真实 START marker。提取随后无法识别已经观察到的 marker，将截断的 marker 片段泄露给模型，并错误报告前缀已丢失。原始预算也有同类问题：包装器回显带有终端插入的换行，长度可能超过预留的包装器长度。此前随上限加入的回归只覆盖无 marker 的回退，没有强制真实的 marker 依赖路径。

## 决定

标准化预算为输出预算保留完整 marker 框架：增量可能携带的两次 prompt 输出（带 32 位状态的 OSC 序列和可打印提示符）、真实 START marker、END marker、状态数字以及换行余量。在真实 START marker 到达前，保留流开头，使跨轮询增量拆分的 marker 仍能到达。观察到 marker 后，保留从该 marker 开始的有界后缀，因此上限不会在 partialOutput 前截断真实 START marker。原始预算按最窄一列终端的情况加入回显包装器长度；物理换行会使包装器加倍，所以尚未标准化的回显也不能把真实 marker 推到上限之外。完整保留的诊断仍受包装器两倍长度、maxOutputChars 与固定框架共同限制。

该回归通过 stub backend 强制真实 marker 依赖的回退，而不是调用合成 helper：增量包含回显包装器、真实 START marker 和部分输出，滚动区不保留这些内容。开发机没有 PowerShell，因此该覆盖位于无密钥单元测试中，真实 shell 组合测试仍由平台 CI 负责。

## 备选方案

**像 bash 镜像一样移除上限。** 否决：未回显的流，或回显始终无法标准化的流，会在整个命令期间无限增长；完整保留的诊断必须有界。

**围绕 marker 裁剪，而不是保留缓冲头部。** 否决：在回显尚未到达、marker 缺失以及包装器中包含回显 marker 副本时，marker 感知裁剪都需要特殊处理；保留完整框架的固定预算以一个上限覆盖所有情况。

**保留无 marker 的回归。** 否决：它在会截断 marker 的实现上也能通过，因为断言同时适用于损坏和修复路径；只有锚定真实 START marker 的回退，才能在上限截断 marker 时失败。

## 验证


`packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` 以很小的输出上限在回显包装器后锚定真实 START marker，断言不会泄露 marker 片段或错误的前缀丢失提示，并在部分输出超过上限时限制渲染结果。该包报告 statement、branch、function 和 line 均为精确 100%；依赖 pwsh 的真实 shell 组合测试在本地自动跳过，并由平台 CI 负责。

## 影响

只要观察到真实 marker，部分和超时诊断就会保留真实命令输出而不是 marker 片段；输出在上限内的命令也不会因 END 框架被截断而错误显示裁剪提示。回退缓冲从 maxOutputChars 加一个提示符增长为包装器两倍、maxOutputChars 与固定框架之和，仍然有界，并由实现保证而不是依赖增量内容假设。

# Agent Note: 将不带状态码的 Codex 过载归类为服务器故障

Status: implemented

[English](2026-09-05-codex-overload-classification.md) | 中文

## 问题

Codex 会报告 “Our servers are currently overloaded. Please try again later.”，却不携带 HTTP 状态码。泛化的 `PI_AI_ERROR` 分类使 normal 重试策略无法恢复这一暂时性的提供方故障。

## 决策

[pi-ai 适配器](../../../../packages/llm/llm-pi-ai/README.zh.md)将已识别的服务器过载消息归类为 `SERVER`。认证、配额及无效请求的分类保留优先级；取消仍保留独立的结束原因。未知错误仍为 `PI_AI_ERROR`。这扩展了基于消息的分类方法，并不取代独立的 [HTTP/2 重置决策](2026-08-25-pi-ai-http2-stream-reset-classification.zh.md)。

既有重试插件拥有延迟、取消及预算。恢复在当前步骤内重复失败的推理请求；它不会重新启动整个轮次，也不会执行尚未提交的响应中的工具调用。

## 考虑过的替代方案

让所有 `PI_AI_ERROR` 都可重试，也会重试格式错误的响应和配置失败。重新提交整个轮次则可能重复已完成的工具副作用。恢复已分类的提供方过载无需采用这两种方案。

## 后果

normal 模式保留已配置的有限重试预算；显式配置的策略保持不变。持续过载仍会在预算耗尽后失败。分类仍依赖提供方措辞，也不会增加提供方容量。

转换与重试测试覆盖所报告的消息、负向分类、部分工具输出、取消和预算耗尽。手工编写的[服务器过载回放](../../../../snapshots/session/server-overload-retry/session.jsonl)通过已发布的 headless profile 记录同一步骤内的恢复；它不是在线 Codex 提供方测试。

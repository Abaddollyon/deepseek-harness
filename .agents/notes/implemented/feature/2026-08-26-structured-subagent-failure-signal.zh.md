# Agent Note：结构化子代理提供方失败信号

状态：已实现

[English](2026-08-26-structured-subagent-failure-signal.md) | 中文

## 问题

子代理结果此前只有有界的诊断文本。父代理可以读到配额说明，却不能可靠地分支而不解析文案，因此可能再次把子代理派发到已经耗尽的路由。

## 决策

SubagentResult.failure 是 diagnostic 的可选机器可读伴随字段。diagnostic 继续承载有界的、人类或模型可读的上下文；failure 承载封闭的提供方无关原因联合（quota、rate-limit、transient 或 permanent）以及可选的提供方请求等待毫秒数。存在 failure 时必定是已知原因；缺少 failure 表示运行未失败或没有获知原因。

未知或未分类错误不会合成原因。消费者必须默认把未来无法识别的联合成员视为不可重试。

映射辅助函数使用现有结构化 LlmFailure 事实，但子代理 seam 保留自己的分类。曾考虑直接复用 LLM 失败代码类型，但予以拒绝：子代理提供方也可以是非 LLM 进程，且让 SubagentResult 依赖 LLM 分类会让一个消费者决定能力 seam。

## 考虑过的替代方案

**解析诊断文本。** 拒绝，因为文案不是稳定的分支键，会重现重复重试已耗尽配额的事故。

**在 SubagentResult 中使用 LLM 失败代码类型。** 拒绝，因为子代理 seam 也服务崩溃、拆卸失败和非 LLM 提供方；该 seam 将已知 LLM 事实映射到自己的提供方无关原因联合。

**增加 unknown 联合成员。** 拒绝，因为它与可选 failure 缺失重叠。缺失明确表示没有已知原因；存在的值都是分类结果。

本笔记部分取代[后台结算诊断](../bug-fix/2026-08-25-background-settlement-diagnostic.zh.md)中关于延后分类的讨论；后者仍是有界可读诊断的权威记录。

## 后果

一次性和后台集成点可以在配额耗尽时停止派发、依据 retry-after 等待，或在已知暂时性失败时改路由，同时不暴露凭据或原始提供方载荷。受保护的生命周期集成仍与本次契约变更分开。

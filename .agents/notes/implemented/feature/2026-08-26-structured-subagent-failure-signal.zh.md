# Agent Note：结构化子代理提供方失败信号

状态：已实现

[English](2026-08-26-structured-subagent-failure-signal.md) | 中文

## 问题

子代理结果此前只有有界的诊断文本。父代理可以读到配额说明，却不能可靠地分支而不解析文案，因此可能再次把子代理派发到已经耗尽的路由。

## 决策

SubagentResult.failure 是 diagnostic 的可选机器可读伴随字段。diagnostic 继续承载有界的、人类或模型可读的上下文；failure 承载 LLM seam 可扩展的类型化失败代码以及可选的提供方请求等待毫秒数。存在 failure 时必定是已知代码，例如 `QUOTA` 或 `RATE_LIMIT`；缺少 failure 表示没有类型化原因到达该 seam。Codex 提供方从 app-server wire 映射类型化提供方事实，并在有界 diagnostic 中保留子进程结果事实；通用 dsh-sdk、ACP 与 Claude Code 传输目前不会产生 `SubagentResult.failure`。`SubagentFinishedNotification` 不携带 failure；TypeScript 与 Python SDK 通知都不扩展该字段。

未知或未分类错误不会合成 failure。消费者必须使用默认分支，并默认把未来无法识别的代码视为不可重试。

曾考虑增加独立的子代理原因分类，但予以拒绝：子代理 seam 已经依赖 dsh-llm，复用其类型化失败代码可以避免重复公开分类，同时让非 LLM 失败保持为缺失信号。

## 考虑过的替代方案

**解析诊断文本。** 拒绝，因为文案不是稳定的分支键，会重现重复重试已耗尽配额的事故。

**创建独立的子代理原因联合。** 拒绝，因为 seam 已经依赖 dsh-llm，其类型化失败代码是有证据支持的路由数据；第二套分类会重复公开选择。

**增加 unknown 成员或合成代码。** 拒绝，因为可选 failure 缺失已经表示没有已分类原因到达该 seam。猜测会让编排器重试无法成功的错误。

本笔记部分取代[后台结算诊断](../bug-fix/2026-08-25-background-settlement-diagnostic.zh.md)中关于延后分类的讨论；后者仍是有界可读诊断的权威记录。

## 后果

一次性本地结果和适用的后台结算通知会携带该信号。父代理通知会说明提供方配额已耗尽或路由暂时受到速率限制，并且只在已知时加入 retry-after 秒数；不会暴露传输术语、凭据或原始提供方载荷。现有拆卸诊断保持不变且仍有界。SDK 的 `SubagentFinishedNotification` 载荷不携带 failure；TypeScript 与 Python SDK 通知都不扩展该字段。

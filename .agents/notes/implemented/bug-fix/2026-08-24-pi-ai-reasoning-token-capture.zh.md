# Agent Note: 在 pi-ai 适配器中捕获提供方上报的推理 token

Status: implemented

[English](2026-08-24-pi-ai-reasoning-token-capture.md) | 中文

## Problem

pi-ai 为暴露了推理拆分的提供方上报推理/思考 token 拆分：OpenAI-completions 路由始终从 `completion_tokens_details.reasoning_tokens` 携带 `usage.reasoning`（模型未思考时为零），OpenAI Responses 路由读取 `output_tokens_details.reasoning_tokens`，Anthropic 路由读取 `output_tokens_details.thinking_tokens`，Google Generative AI 与 Vertex 路由读取 `usageMetadata.thoughtsTokenCount`。pi-ai 适配器的 `mapUsage` 丢弃了该字段，因此经 pi-ai 路由的每个会话记录的 usage 都不带 `reasoningTokens`，尽管自 DeepSeek 适配器开始填充以来 `TokenUsage` 一直带有这个可选字段。折叠会话日志的消费方——跨会话用量聚合、trajectory 的单请求检查器——对 pi-ai 路由只能渲染恒为零的推理数字。

## Decision

`dsh-llm-pi-ai` 的 `mapUsage` 现在在 pi-ai 上报拆分时将 `usage.reasoning` 透传为 `reasoningTokens`，包括上报的零——它标记该路由的提供方暴露了拆分。没有拆分的提供方保持字段缺省，因此缺省仍然表示“未记录”，而不是“没有思考”。四个计费桶不受影响：`reasoningTokens` 是 `outputTokens` 的子拆分，token-meter 投影继续只累加互斥桶，因此任何计数都不会重复入账。

会话日志机制不变：`assistant/message` 的载荷本就声明为 `usage?: TokenUsage`，该字段可选，且因为没有结构性变化，`SESSION_FORMAT_VERSION` 保持为 0。历史日志只是缺少该字段，读取方必须把它当作“未记录”，绝不能当作实测的零。

## Alternatives considered

**从流式内容估算推理 token。** 已否决，因为持久化的推理块文本是事后产物：被编辑或加密的思考内容没有可信文本，按字符计数会编造提供方从未上报的数字。

**增加第五个累加用量桶。** 已否决，因为提供方把推理计入输出计费；再累加一次会让每个思考 token 在总量与上下文压力投影中被重复计算。

**继续丢弃该字段。** 已否决，因为数据恰好在部署运行重推理模型的路由上存在于适配器边界，丢弃它会让每个下游推理数字都成为虚构。

## Verification

`mapUsage` 单元测试固定了透传行为（上报值、上报的零、以及缺省），包括 `outputTokens` 不因拆分而增长。基于 mock OpenAI-completions 端点的适配器集成测试现在在普通补全上观察到 `reasoningTokens: 0`，与 pi-ai 在该 API 上始终提供拆分的行为一致。`usage-reasoning-split` 会话快照回放了一个用量在精确 `totalTokens` 旁携带该拆分的轮次，证明两者都会持久化到会话日志与组装出的 assistant 消息中。

## Consequences

pi-ai 路由上的新会话记录真实的推理拆分；Anthropic、OpenAI Responses、Google Generative AI 与 Google Vertex 路由在提供方上报时记录，而 OpenAI completions 会提供包括零在内的拆分。历史会话没有推理数据，因此跨会话读取方必须区分“未记录”与零。本就会在字段存在时渲染 `reasoningTokens` 的单请求 trajectory 检查器，现在无需改动即可为 pi-ai 路由显示数字。

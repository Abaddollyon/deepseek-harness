# Agent Note: 把 pi-ai 的 HTTP/2 流重置归类为可重试的传输失败

Status: implemented

[English](2026-08-25-pi-ai-http2-stream-reset-classification.md) | 中文

## 问题

HTTP/2 提供方或中间层可能在响应中途重置单条流（nghttp2 的 `RST_STREAM` 帧），而连接本身仍然健康。pi-ai 会把这类失败扁平化成消息文本，例如 `stream error: stream ID 1; INTERNAL_ERROR; received from peer`，或 Node 渲染的 `NGHTTP2_*` 错误码；`dsh-llm-pi-ai` 里的 `classifyPiAiError` 此前不识别其中任何一种措辞：它们落入兜底的 `PI_AI_ERROR`，而默认的 `llm-retry` 策略不会重试该 code。单条流被重置是典型的暂时性故障——重新发起一次请求通常就能成功——但当时整个轮次会直接失败。

该行为此前以 `apply-rc6-http2-stream-retry` 编译产物补丁的形式存在，在升级到上游 0.1.1-rc.2、退役编译补丁时被一并悄悄丢弃。本笔记记录把它在源码中重新落地，扩展了[传输截断分类](2026-07-22-pi-ai-transport-truncation-classification.zh.md)。

## 决策

- `classifyPiAiError` 把 HTTP/2 流重置词汇映射为 `TRANSPORT`：nghttp2 的 `stream error: stream ID N; <CODE>; received from peer` 措辞（按 `stream error` 与 `received from peer` 匹配）、`RST_STREAM` 帧名，以及 `NGHTTP2_` 错误码前缀。对端重置的是一条流而不是整个连接，因此重发请求可能成功；默认重试策略本就把 `TRANSPORT` 列为可重试。
- `received from peer`、`RST_STREAM` 和 `NGHTTP2_` 只出现在 HTTP/2 重置词汇中，不会把真正的模型层错误吞进重试循环。裸 `stream error` 签名必然更宽：它正是 nghttp2 对这类失败的引导措辞。
- `mapStopReason` 中的无详情错误兜底（pi-ai 报告失败却不带消息时的 `pi-ai stream error`）现在显式归类为 `PI_AI_ERROR`，不再经过分类器：其字面文本含有 `stream error`，而未知原因绝不能经由重置签名进入重试循环。
- 一个转换测试端到端断言这条链路：重置措辞被归类为 `TRANSPORT`，且默认解析出的重试策略确实重试 `TRANSPORT`。

## 否决的替代方案

**只匹配完整的 nghttp2 短语（`stream error` 与 `received from peer` 同时出现）。** 否决：Node 的 `ERR_HTTP2_STREAM_ERROR` 渲染为 `Stream closed with error code NGHTTP2_*`，两个短语都不含，而中间层只会报裸 `RST_STREAM` 帧名；要求组合短语反而漏掉这些签名各自覆盖的渲染形式。

**让无详情兜底也归类为 `TRANSPORT`。** 否决：兜底意味着 pi-ai 报告了失败却没有任何信息；把未知原因按策略上限重试会浪费配额，并拖延真正持续性错误的暴露。

**改为按结构化的 `code`/`cause` 分类而不是按文本。** 依然不可行，如前置笔记所述：pi-ai 在发出终止事件前已把捕获的错误扁平化为 `error.message`，文本匹配仍是唯一信号。分类器上的 `XXX(pi-ai upstream)` 注释仍指向那个根治方向。

## 后果

- HTTP/2 流重置现在会在默认提供方重试策略下重试，而不是让轮次失败；持续性重置仍会在策略配置的重试次数用尽后终止。
- 到达用户的失败文本不变；只有路由出的 `code` 改善了，与截断分类的情形完全一致。
- 分类仍依赖措辞：nghttp2 或 Node 将来的版本若改写这些错误文本，会在模式更新之前静默退回 `PI_AI_ERROR`。

---
kind: upgrade-guide
description: "模型请求重试默认错开等待时间，遇到更长的提供方延迟时等待 maxDelayMs 而不是结束轮次，pi-ai 失败会携带 HTTP 状态。"
---

# 模型请求重试错开等待时间并遵循提供方延迟

[English](guide.md) | 中文

## 变更

提供方 `retryPolicy.backoff` 接受 `jitter: full | symmetric`。默认值从 `jitterRatio: 0.1` 的 symmetric 抖动改为 `jitterRatio: 1` 的 `jitter: full`。对于指数延迟 `d`，本地等待落在 `[0, d]`，而不是 `[0.9 d, 1.1 d]`。对于已接受的提供方延迟 `p`，等待落在 `p` 与 `min(p + max(d, p), maxDelayMs)` 之间，而不是恰好为 `p`。被同一次限流突发拒绝的 agent 不再一起重试。

超过 `maxDelayMs` 的提供方延迟在两种模式下都恰好等待 `maxDelayMs`。此前 normal mode 会因此结束轮次，always mode 则使用本地退避。

使用 `anthropic-messages`、`azure-openai-responses`、`mistral-conversations`、经 SSE 的 `openai-codex-responses`、`openai-completions`、`openai-responses` 与 `pi-messages` 的 `dsh-llm-pi-ai` 路由，会给错误响应之后的失败附加 `status` 与 `providerRetryAfterMs`。在 408、429 或 5xx 之后、适配器无法识别的错误文本以可重试的 `TIMEOUT`、`RATE_LIMIT` 或 `SERVER` 失败，而不是 `PI_AI_ERROR`。pi-ai 的 Codex 句子 `You have hit your ChatGPT usage limit…` 以 `QUOTA` 而不是 `PI_AI_ERROR` 失败；normal mode 对这两个 code 都不重试。profile 可以设置 `maxConcurrentRequests`；省略时路由不受限制。

受影响的是使用默认退避、依赖较长 `Retry-After` 结束轮次，或匹配这些路由 `PI_AI_ERROR` code 的部署。

## 迁移

1. 若要保持此前的等待时间，在 `cordis.yml` 或其 patch 中为每个提供方的 `retryPolicy` 设置退避，并保留策略现有的 `mode`：

   ```yaml
   retryPolicy:
     mode: normal
     backoff:
       jitter: symmetric
       jitterRatio: 0.1
   ```

2. 若要限制超过 `maxDelayMs` 的提供方延迟之后的重试次数，调低 `retryPolicy.maxRetries`；没有任何设置会因较长延迟结束轮次。
3. 把消费方对 pi-ai HTTP 失败 `PI_AI_ERROR` 的检查替换为 `TIMEOUT`、`RATE_LIMIT`、`SERVER`，Codex 用量上限则替换为 `QUOTA`。
4. 确认迁移成功：每个 `llm/retry` 会话事件的 `delayMs` 位于上述范围内，Codex 用量上限失败以 code `QUOTA` 结束其轮次。

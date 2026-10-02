# Agent Note: 代理号池路由

Status: implemented

[English](2026-10-02-proxy-pool-routes.md) | 中文

## Problem

自有提供方账号的号池（Codex 号池或 Claude 订阅号池）位于目录路由键 `openai-codex` 与 `anthropic` 之后，因为已保存会话和默认值都引用这些键。在这类路由上，pi-ai 的目录鉴权会读取已存储的登录、刷新已存储的 OAuth 授权并读取环境中的提供方变量，因此 Harness 可能与号池争夺刷新所有权，或发送号池从未签发的凭据。pi-ai 还只在密钥包含 `sk-ant-oat` 时选择 Claude Code 请求格式，并拒绝无密钥的 Anthropic 请求，因此无密钥的 Claude 号池根本无法访问。模型发现对这两个路由键都由已安装目录回答，号池提供的模型与推理等级因此不可见。

## Decision

`dsh-llm-pi-ai` 路由接受三个显式选项，省略时均保持原行为。`authMode: proxy` 只用 Harness 的 api-key 方法构建路由，适配器集合对该路由 id 回答「未存储」并拒绝凭据写入，因此不会读取或刷新任何已存授权，也不会查询环境变量；请求携带 `apiKeyEnv` 的值或不带凭据。代理模式要求显式且不含内嵌凭据的 http(s) `baseURL`。`anthropicRequestMode: claude-code` 仅对 `anthropic-messages` 路由有效，设置 pi-ai Anthropic 的 `requestMode` 流选项。`modelDiscovery.source` 让现有发现操作以 OpenAI 兼容或 Anthropic 列表协议列出路由自己的端点，并映射报告的输入类型、推理等级与 Anthropic 自适应思考（作为 `compat.forceAdaptiveThinking`），丢弃 pi-ai 无法表达的等级。

`requestMode` 选项是现有 pi-ai pnpm 补丁中的一个 hunk。它应用 OAuth 令牌所选择的身份标头、beta 特性、系统前导与工具名映射，把非 OAuth 密钥作为 `X-Api-Key` 发送；无密钥请求则传入空 bearer 令牌并将两个鉴权标头置空，使 Anthropic SDK 既不解析环境凭据也不发送凭据。

## Alternatives considered

**包含 `sk-ant-oat` 的占位密钥。** 它能在原版 pi-ai 上选中该格式，但靠拼写改变行为的假凭据是不可见的配置，pi-ai 一旦改动该检查就会失效。

**根据主机、端口或标记标头识别号池。** 部署地址各不相同，标记标头还会到达上游提供方；模式必须显式声明，而非推断。

**在 `dsh-llm-pi-ai` 中加入定期目录刷新器。** pi-ai 自身的刷新会读取并刷新路由的已存凭据，而 Harness 自有的刷新器会再增加一个模型注册表。改由插件调用现有发现操作并把结果写入设置。

## Consequences

- 号池路由在已发布运行时上通过配置即可工作，无需改写已安装的 JavaScript。
- pi-ai 补丁文件现在承载两项改动，在 pi-ai 提供等效选项之前，每次升级都必须重新应用。
- `LlmDiscoveredModel` 新增 `reasoningEfforts` 与按适配器命名的 `compat` 开关；发现仍不存储任何内容，因此刷新绝不会改变默认值、凭据或会话的模型。

# @deepseek-ai/dsh-web-search-codex

[English](README.md) | 中文

面向 [`ctx.web`](../web/README.zh.md) 的官方订阅原生 Codex 网页搜索提供方。它把固定版本的官方 `@openai/codex` 包作为 `codex app-server --stdio` 启动，执行官方初始化握手，创建一个临时线程，并为每个有序查询批次运行一个 turn。认证由 Codex 及其 app-server 持有；本包从不读取、复制、记录、导出或转发 OAuth token，也绝不回退到 API-key 提供方。

提供方在 `thread/start` 将 `live` 映射为原生 `web_search: 'live'`，将 `cached`／`indexed`／省略映射为 `'cached'`，并启用布尔型 `tools.web_search`，然后只从 item 类型为 `webSearch` 的结构化 `item/completed` 值派生引用。终端助手文本不能创建来源 URL。缺失或重复的搜索 item 会成为安全的 `WEB_PROVIDER_PROTOCOL` 结果。内部没有隐藏重试。web seam 负责最终 HTTP(S) 规范化、规范去重、缓存、singleflight 和来源数量限制。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `cwd` | Host 进程 cwd | 传给临时 app-server 线程的工作目录。 |
| `graceMs` | `3000` | 托管进程树终止宽限时间。 |

插件注入 `web` 和 `subprocess`。每个原生批次拥有一个官方进程、一个临时线程和一个 turn。取消会在协议 id 已知时请求 `turn/interrupt`，关闭 JSON-RPC 连接，终止完整托管进程树，并在拒绝前等待进程结算。`available()` 是不执行搜索的包就绪检查；授权错误保留在官方运行时内部，并表现为安全的提供方错误。

## 模型体验

### 原生 Codex 搜索 turn

#### 模型可见内容

一个临时 Codex 线程接收生成的指令，其中包含有序的缓存 miss 查询以及域名和位置引导；新鲜度在线程上配置，结果由 web seam 限制。它不会收到 DSH 会话历史、提供方凭据、OAuth token 或先前搜索会话。

#### Token 影响

每个协调后的 miss 批次使用一个订阅原生 Codex turn。官方运行时拥有用量计量；不存在 API-key 搜索请求或重试。

#### KV Cache 影响

线程是临时的且绝不恢复，因此原生搜索批次不共享持久化会话前缀，也不影响 DSH 会话模型的缓存。

### 会话工具结果（间接）

#### 模型可见内容

通过 `@deepseek-ai/dsh-tool-web` 间接体现：成功的规范化引用和安全的部分失败会保留在已记录的工具结果中。提供方、进程、账户和协议细节不会加入面向模型的工具 schema 或提示词。

#### Token 影响

使用前不增加提示词 token。每次调用会把消费方渲染的成功答案、受限引用和安全的逐查询失败加入已记录的工具结果。

#### KV Cache 影响

以追加方式位于可复用会话前缀之后；保留的搜索结果遵循工具消费方的压缩行为。

## 已知限制与延后工作

- 固定版本的 Codex 只接受布尔型 `tools.web_search` 值。因此允许／阻止域名和位置会进入精确批次指令；每个返回引用都会独立按允许和阻止主机名进行后置过滤，阻止域名优先。上游搜索仍可能查看不允许的结果，但该结果不能到达调用方。
- app-server 的结构化搜索结果值是有意保持前向兼容的 JSON。本提供方只保留直接的非空 `url`、`title`、`snippet`、`publishedAt` 和 `published_at` 字符串字段，并忽略未知条目。它绝不从终端文本派生引用。
- 在不跨越官方认证边界的情况下，available 无法检查 OAuth 状态，因此只有 app-server 运行时才验证认证。

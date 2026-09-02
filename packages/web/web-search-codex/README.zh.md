---
description: "ctx.web 的 Codex 订阅搜索提供方：严格 app-server 回放、有界结果、脱敏失败与进程树清理。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-codex

[English](README.md) | 中文

## 概述

此 Cordis 插件通过 ctx.web 注册固定的 codex 搜索提供方，并为每次请求运行一个临时 Codex app-server 进程。当已登录的 Codex CLI 订阅需要在不配置 API 密钥的情况下提供网页搜索时选择它。它没有回退链，也从不读取凭据文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经加载 web 与 subprocess 服务的组合中挂载本包，然后选择 searchProvider: codex。请先在 DSH 之外运行 codex login。DSH 从不读取 ~/.codex、认证文件、凭据或密钥链，也从不执行登录或探测搜索。

| 字段 | 默认值 | 范围与含义 |
|---|---|---|
| cwd | process.cwd() | 临时线程使用的现有工作目录 |
| requestTimeoutMs | 60000 | 1 到 600000 的整数 |
| disposeGraceMs | 3000 | 1 到 60000 的进程树终止宽限整数 |
| maxResults | 8 | 1 到 50 的整数 |
| maxPayloadBytes | 262144 | 1048 到 1048576 的整数 |
| executable | 包内包装器 | 裸命令或绝对路径 |

可用性仅同步提示配置与文件系统状态。每次请求都会在启动前异步解析可执行文件。默认启动方式是 Node 加包内 OpenAI Codex 包装器，再附加 app-server 与 --stdio。

已完成的结构化 webSearch 项目会成为 HTTP 或 HTTPS 来源。URL 会被验证，按首次出现顺序去重和截断，并可与最终代理答案配对。调用方取消报告 WEB_ABORTED。无效帧、冲突标识符、失败轮次与缺失结构化项目报告 WEB_PROVIDER_PROTOCOL。稳定的非零退出认证证据会产生可操作登录消息；原始诊断从不进入面向用户的错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

协议层执行 initialize 与 initialized，创建启用实时网页搜索、审批策略为 never 的临时只读线程，启动一个轮次，响应 currentTime/read，拒绝其他服务端请求，并接受早于请求响应到达的通知。线程与轮次标识符保持严格关联。

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 配置 schema、提供方注册与 Fiber 持有的注销器 |
| [src/provider.ts](src/provider.ts) | 可执行文件解析、进程生命周期、错误映射与规范化 |
| [src/wire.ts](src/wire.ts) | 窄化 JSON-RPC app-server 协议与关联 |
| [tests/fixtures](tests/fixtures) | 确定性的成功、失败与畸形回放记录 |
| — | 不发布运行时 invariant companion；除加载器与回放测试覆盖的行为外，本包不拥有独立事件流或公开可变关系。 |

取消、超时、正常完成与 Fiber 销毁时，若标识符已知，则尽力发送 turn/interrupt，关闭传输，并通过 ctx.subprocess 终止完整进程树。销毁流程等待静止后再注销提供方。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 子系统](../../../docs/subsystems/web.zh.md)——共享搜索请求、结果与错误词汇。
- [Web 服务](../web/README.zh.md)——注册表与提供方选择所有权。
- [Web 工具](../tool-web/README.zh.md)——面向模型的来源与失败呈现。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-codex)——穷尽式的受支持字段。
- [订阅提供方 Agent Note](../../../.agents/notes/proposed/architecture/2026-09-02-subscription-web-search-provider-contract.zh.md)——进程与协议依据。

-----

<a id="model-experience"></a>
## 模型体验

通过 dsh-tool-web 间接提供：模型会收到有界可引用来源与可选答案内容或稳定且脱敏的失败，同时 Codex 凭据、CLI 记录、stderr 与本地认证路径都不会进入模型上下文。

#### KV Cache 影响

不会直接失效；请求前缀变更由消费方 web 工具负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 每次提供方请求只接受一个查询与一个 webSearch 项目；原生 Codex 批处理已延期。
- 可用性不证明认证成功，因为真实登录与搜索探测被有意禁止。
- 窄化 app-server schema 由回放固定，Codex 更改协议时必须更新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

未来协议扩展应保留在提供方内部，直到 Web seam 拥有提供方无关字段。保持认证分类窄化，保持原始进程输出脱敏，并在每次接受协议变更时更新精确回放夹具。

</details>

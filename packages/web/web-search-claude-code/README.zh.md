---
description: "通过官方 Agent SDK 与托管 subprocess seam 为 ctx.web 提供 Claude Code 订阅搜索。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-claude-code

[English](README.md) | 中文

## 概述

本插件向 `ctx.web` 注册固定的 `claude-code` 搜索提供方。每个请求只运行一次官方 Claude Agent SDK `query()`，仅启用 `WebSearch`，使用结构化 JSON 输出、不持久化会话，并限制 turn 数。它使用用户已有的 Claude Code 订阅登录，既不读取、复制，也不探测凭据。

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

加载 `web`、一个 `subprocess` 实现以及本插件。注册多个搜索提供方时，在当前 profile 中用 `web.searchProvider: claude-code` 明确选择它。

### 最小组合

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-web-search-claude-code'
  config:
    cwd: .
    requestTimeoutMs: 60000

web:
  searchProvider: claude-code
```

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `cwd` | `process.cwd()` | 搜索启动时解析并验证的工作目录 |
| `requestTimeoutMs` | `60000` | 请求截止时间；1 至 600000 的安全整数 |
| `disposeGraceMs` | `3000` | 进程树终止宽限；1 至 60000 的安全整数 |
| `maxResults` | `8` | 规范化来源上限；1 至 50 的安全整数 |
| `maxTurns` | `4` | Agent SDK turn 上限；1 至 16 的安全整数 |
| `maxPayloadBytes` | `262144` | 序列化结果上限；1048 至 1048576 的安全整数 |
| `executable` | SDK 包默认值 | 可选的非空白裸名称或绝对路径 Claude 可执行文件覆盖 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-claude-code)是穷尽式声明参考。

### 登录与可用性

DSH 从不读取 `~/.claude/*`、钥匙串、环境凭据存储或提供方 token。认证仍归 Claude Code 所有；请在 DSH 外运行 `claude login` 登录。`available()` 只是同步的可执行文件／配置提示，刻意不执行搜索或认证探测。

稳定认证证据会准确返回：`Sign in with Claude Code (claude login) and retry; DSH does not read provider credentials`。

缺少可执行文件会准确返回：`Claude Code CLI is unavailable; install Claude Code and retry; DSH does not read provider credentials`。

### 结果与失败

提供方要求恰好一个匹配的原始 `WebSearch` 结果以及一个成功的结构化结果。它规范化 HTTP(S) 来源、按 URL 去重、应用来源与 UTF-8 payload 上限，并把有依据的答案作为 `content` 返回。缺失、重复、畸形或不匹配的协议数据返回 `WEB_PROVIDER_PROTOCOL`；取消返回 `WEB_ABORTED`；超时与经脱敏的执行失败返回 `WEB_PROVIDER_ERROR`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **订阅认证始终归提供方所有。** 适配器不会把 Claude 凭据转换成 Harness secret。
- **所有进程始终归 seam 所有。** Agent SDK 自定义 spawn 回调通过 `ctx.subprocess` 投影，因此每次查询只有一棵托管进程树。
- **只有公开且有界的错误跨越 seam。** 原始 SDK、resolver、stderr 与文件系统错误会被分类后丢弃，不会作为可序列化 cause 附加。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置验证、固定 ID 注册与 effect 作用域生命周期 |
| [`src/provider.ts`](src/provider.ts) | Agent SDK 协议、规范化、错误分类与进程清理 |
| [`tests/provider.spec.ts`](tests/provider.spec.ts) | 无密钥 SDK replay、协议、脱敏、竞态与清理覆盖 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | loader 注册、重复拒绝、启动阻塞时处置与公开再导出 |
| — | 不发布运行时 invariant companion；除 web 与 subprocess seam 强制执行的约定外，此适配器不拥有独立事件序列或可变数据关系。 |

### 生命周期

注册产生两个 LIFO 清理项：先运行提供方处置，中止全部活动 controller，并等待每个查询／进程树结束；然后 registry disposer 才注销 `claude-code`。可执行文件解析与 SDK 启动前后都有中止检查，而已 spawn 的子进程会在任何后续 await 之前同步记录，因此 teardown 不会遗漏进程。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [web 子系统](../../../docs/subsystems/web.zh.md)——共享搜索约定与提供方选择。
- [web 包映射](../README.zh.md)——提供方包家族。
- [subprocess 包](../../subprocess/subprocess/README.zh.md)——托管进程树约定。
- [公开适配器导出决策](../../../.agents/notes/implemented/architecture/2026-09-02-claude-code-adapter-public-exports.zh.md)——为何共享 Claude 适配器 helper 属于包 API。

-----

<a id="model-experience"></a>
## 模型体验

模型间接通过 `dsh-tool-web` 获得简洁的有依据答案与有界引用来源，而公开失败只暴露稳定 code 与可操作消息。

#### KV Cache 影响

不会直接失效；任何 prompt 前缀呈现由 web 工具所有。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **必须已安装并登录 Claude Code**——本插件从不执行登录或凭据发现。
- **只启用 `WebSearch`**——文件、shell、MCP 与其他 Agent SDK 工具刻意不可用。
- **一次查询创建一个进程**——没有会话复用、批处理、回退提供方或协调器。
- **`cwd` 来自提供方配置**——`WebSearchRequest` 不携带会话工作目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

保持 replay 测试无密钥。新的 SDK 消息形状必须先捕获为有界 fixture，并且不得削弱“恰好一个原始 `WebSearch`”规则或“不公开 cause”规则。

</details>

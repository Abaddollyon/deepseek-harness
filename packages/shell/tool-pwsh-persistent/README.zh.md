---
description: "面向模型的持久 pwsh 工具，供选择、配置或排查跨调用保留的按所有者隔离 PowerShell shell 状态的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-pwsh-persistent

[English](README.md) | 中文

## 概述

 dsh-tool-pwsh-persistent 为 agent 提供 pwsh 工具，其 shell 状态对拥有它的 agent 跨调用保留：cwd、导出的环境变量、函数与后台任务都会在命令之间存活。每个 agent 都有由 terminal 服务提供的按所有者隔离 PTY 会话，同一 agent 的命令逐个执行。配置选择 terminal backend、截止时间、输出上限和面向模型的描述。超时、显式 exit 或发送失败会关闭 shell，下一次调用从全新状态开始。请与配置为 shellDialect: pwsh 的 terminal-bash 等 terminal 后端以及 ctx.terminals 服务一起挂载。

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

在 agent 需要在命令之间保持 PowerShell 状态的任何组合中加载本插件，例如 Windows 构建会话或为后续步骤导出变量的脚本。它注册 pwsh 工具，需要 ctx.tools 与 ctx.terminals 服务，并在执行时需要拥有者 agent 会话。

### 何时选择

当工作依赖跨调用状态时选择持久工具。当每条命令都应从干净环境开始时选择一次性 shell 工具。这里不支持需要交互 stdin 的命令：读取输入的前台命令会阻塞到就绪超时，随后重置 shell。

### 最小配置

默认 shell 后端使用配置为 pwsh 方言的 terminal-bash；部署方可以注册其他 terminal backend 并按名称选择。

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellDialect: pwsh
- name: '@deepseek-ai/dsh-tool-pwsh-persistent'
  config:
    backendType: shell
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backendType` | `shell` | 用于每个 agent shell 的已注册 terminal backend |
| `timeoutMs` | `300,000` | 单条命令的墙钟上限；超时关闭 shell |
| `maxOutputChars` | `16,000` | 保留的命令输出字符上限；固定诊断信息在其后追加 |
| `description` | 持久 shell 描述 | 面向模型的环境约定 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### agent 可以依赖什么

命令共享每个 agent 一个 shell，因此 cwd、`$env:` 变量、函数与后台任务跨调用保留。结果排除私有完成标记、shell 提示符与回显输入。非零命令追加 `[exit code: N]`；在报告状态前退出的 shell 追加 shell 退出状态，然后重置。长输出保留最早的已保留前缀并附裁剪提示；若 terminal 已丢弃该前缀，结果会明确说明。超时返回有界部分输出、关闭不确定的 shell 并报告重置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本插件按需创建一个按所有者隔离的 shell，用携带退出状态的唯一 START 与 END marker 包装每条命令，以 1,000 行一页轮询 scrollback，并提取真实 marker 之间的区间。PowerShell 行编辑器回显通过匹配可容纳终端物理换行的精确包装器原文移除。若 scrollback 无法回答，增量回退会保留完整 marker 框架，在观察到 START marker 后以其为锚点，再限制部分输出；回退始终受包装器长度与输出上限共同限制。超时或 shell 状态不确定时会重置拥有者 shell。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：shell 注册表、命令包装、回退保留、scrollback 轮询、提取与渲染 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；shell 复用可通过工具执行观察） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [terminal 包映射](../../terminal/README.zh.md)——持久 PTY 能力家族。
- [terminal seam](../../terminal/terminal/README.zh.md)——工具背后的 ctx.terminals 服务。
- [terminal-bash 后端](../../terminal/terminal-bash/README.zh.md)——默认后端与 pwsh 方言提供方。
- [tool-terminal](../../terminal/tool-terminal/README.zh.md)——面向交互工作的模型侧 terminal 工具。
- [持久 PTY 会话 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-11-pwsh-persistent-pty.zh.md)——按所有者会话的设计及其理由。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)——pwsh 参数 schema 的确切内容。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)——受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

生成的 [`pwsh` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)，包括配置的 `description`。本插件不贡献独立的 system-prompt 段落；人设与环境指引由部署方负责。

#### Token 影响

`pwsh` 可见期间产生固定 schema 开销。

#### KV Cache 影响

只要配置的描述与 schema 不变，前缀就保持稳定。

### 工具结果

#### 模型看到什么

命令共享每个 Agent 一个 shell，因此 cwd、`$env:` 变量、函数与后台任务都会跨调用保留。结果排除私有完成标记、shell 提示符与回显输入（PSReadLine 会把提交的输入渲染回输出流；marker 锚定提取与可跨越终端物理换行的精确包装器匹配将其移除）。非零包装命令追加 `[exit code: N]`；原生命令保留原生退出码，PowerShell 终止性错误使用 1。shell 在报告状态前退出的会追加 shell 退出状态并重置。长输出保留最早的已保留前缀并附裁剪提示；若 scrollback 已丢弃该前缀，结果会明确说明。超时返回有界部分输出、关闭不确定的 shell 并报告重置。

#### Token 影响

依数据而定。`maxOutputChars` 限制保留的命令输出；固定的裁剪、丢失前缀、状态、超时与重置诊断可能延长结果。

#### KV Cache 影响

追加式工具结果跟随可复用的请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 工具需要拥有者 Agent 与一个真实支持 pwsh 方言的 terminal backend（Windows ConPTY 或 POSIX pwsh）。
- **输入回显不可避免**：PowerShell 的行编辑器会把提交的输入渲染回终端流，移除 PSReadLine 也不会抑制这种渲染。完整结果中 marker 锚定提取排除回显，回退路径中的匹配可跨越物理换行。若 scrollback 在捕获前裁掉包装器的一部分，无法匹配的片段仍可能保留在不完整结果中；保留的回退包含固定 marker 框架，并受包装器长度与 `maxOutputChars` 共同限制。
- 模型命令中的裸 ESC 字符不受支持：PSReadLine 会在执行前吞掉它们。包装器转义它需要的控制字节，包括由 `[char]27` 构造的 OSC marker 与 body 的反引号转义。
- 模型重定义 `prompt` 函数会移除就绪 marker；shell 会通过可打印提示符或静默档结算。
- 命令执行期间没有交互 stdin；读取输入的前台命令会阻塞到就绪超时，随后重置 shell。
- SIGTSTP/SIGHUP 在 Windows 不可用；SIGINT 以控制台级 Ctrl-C 输入投递，在提示符处取消当前行而非向进程发信号。
- 在 Windows ACL 沙箱的只读模式下，pwsh 以 ConstrainedLanguage 启动，可能拒绝引导代码固定 Console 编码并写入 prompt marker。命令仍可通过可打印提示符和静默档结算，但非 ASCII 输出可能沿用宿主代码页。
- BEL 终结的 OSC marker 仍只是就绪信号；面向模型的 BEL 事件通道保持延后。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

没有 PowerShell 时，依赖 PowerShell 的组合测试会自动跳过。无密钥单元 fixture 覆盖 marker 提取、回显包装器、就绪回退、有界部分输出、shell 退出、超时与生命周期释放。

</details>

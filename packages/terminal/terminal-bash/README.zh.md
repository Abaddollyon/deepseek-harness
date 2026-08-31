---
description: "持久 terminal-bash 后端，供选择、配置或排查 PTY shell 会话与就绪行为的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal-bash

[English](README.md) | 中文

## 概述

`dsh-terminal-bash` 通过 `ctx.subprocess.spawnTerminal` 为 `ctx.terminals` 提供持久后端。它在共享沙箱策略下启动交互式 bash 或 pwsh 会话，保留有界逐行输出并检测就绪状态；进程管理提供方负责 PTY 分配、环境清理、前台进程组、信号发送和完整终端会话清理。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这是一个基于 `ctx.subprocess.spawnTerminal`、为 `ctx.terminals` 提供的持久 shell 后端。它在共享 `ctx.sandboxPolicy` 下启动交互式 shell，保留有界的逐行输出并检测就绪状态；进程管理提供方则负责 PTY 分配、环境清理、前台进程组、信号发送和完整终端会话清理。因此，同一个 PTY 后端可以与本地或远程执行世界提供方组合。

### 插件（`terminal-bash`）

该插件注入 `pty`、`sandboxPolicy` 和 `subprocess`，然后注册所配置的后端类型（`shell`）。`danger-full-access` 无需沙箱提供方即可直接启动 shell；受限模式要求同一执行世界中存在 `ctx.sandbox`，并通过它包装确切的 shell argv，未挂载时会在 spawn 前失败。spawn 时，一次 `ctx.sandboxPolicy.resolve({ session })` 调用会同时给出实际模式与会话工作区根目录；调用方省略 cwd 时，同一根目录也是 shell 的默认 cwd。当某个所有者存在开放的 PTY 或正在进行 spawn 时，如果配置变更会得到不同的实际模式，系统会在对应 `sandbox/mode` 事件提交前拒绝该变更。该限制绑定到确切所有者，因此即使提供方重新加载并保留现有会话，它仍然有效。更改模式前，请等待创建完成并关闭会话，避免以更宽权限打开的终端在权限降级后继续存在。

`shellDialect` 选择 shell 栈（默认 `bash`，或 `pwsh`）：它决定默认的 `shellPath`／`shellArgs`（bash 为 `--noprofile --norc -i`；pwsh 经共享的 `dsh-pwsh-local` 解析器得到 `-NoLogo -NoProfile`）与启动契约。bash 方言通过环境安装提示符（`PS1` 加 OSC `133;D;` 终结的 `PROMPT_COMMAND`）。pwsh 无法从环境安装提示符，因此后端会立即提交一条引导 send，其中包含共享编码前缀与 `prompt` 函数；同时其环境去掉 bash 专属标记并加 `NO_COLOR`。启动只在精确的 stdin 等待结算上完成——即经 shell 前台进程组验证的受控提示符标记，或精确的前台 stdin 等待证据。静默结算不是启动就绪，而是触发另一条不含输出的后续观察 send；所有重试共同受一个绝对 deadline 约束。编码前缀会在提示符设置运行前把 `[Console]::OutputEncoding` 与 `$OutputEncoding` 钉为 UTF-8：会话解码路径按 UTF-8 读取 PTY 字节，未钉住编码的控制台会以宿主代码页输出非 ASCII 内容。两种方言发出相同的 BEL 终结 OSC 标记，因此就绪机制与消费方与方言无关。

就绪检测结合以下机制：由前台状态验证的私有 bash 提示符标记、提供方报告的前台 stdin 等待事实、静默回退和绝对超时。行式终端用稳定原点响应光标位置查询，使 PowerShell 行编辑器无需屏幕模型也能完成渲染。只有最新自有标记之后的可打印尾部与受控 `PS1` 完全相等，标记才算就绪；即使 OSC 标记和提示符被拆到多个数据回调中也一样。因此，较早提示符之后的回显输入或输出无法使当前 send 完成。受控 `PROMPT_COMMAND` 会在每次输出提示符前重新设定该 `PS1`，因此在 shell 内覆盖提示符不会使后续 send 退化到静默就绪。提供方写入前收集的提示符与静默证据，包括写入前前台检查仍在等待时收集的证据，都会在写入边界丢弃。非空写入只有在该次 send 已产生输出后才能通过静默结算；等待延迟提示符输出的空观察 send 可以使用静默档。如果 bash 在终端提供方发布其重新取得前台进程组的状态前打印标记，轮询会在普通静默上限之后再保留该候选状态 `handoffGraceMs`，使恰好同时发生的前台交接有机会胜出。因此，继承 `PROMPT_COMMAND` 的交互式子进程无法一直抑制推断空闲就绪直至绝对超时。未知的前台状态绝不会作为精确空闲的正向信号。同样，一次 send 之前就已存在的前台进程组 stdin 等待并不代表写入后就绪：必须先观察到同一进程组脱离该等待，之后再次进入等待才能使该次 send 完成；前台进程组发生变化则构成新的证据。尚未发布的启动过程中，回退路径要求已经观察到输出；零输出静默不能发布空会话，超时则拒绝 spawn。取消操作会关闭尚未发布的 shell，并以调用方提供的确切中止原因拒绝；`TerminalBackendCleanupError` 会单独保留清理失败。调用方的 signal 会转发给终端分配与就绪初始化；发布后，句柄负责其生命周期。未完成的终端控制序列受 `maxReadBytes` 限制；超过上限后，系统会丢弃内容直到其终止符。格式错误的 UTF-8 终端输出使用替换字符；末尾的回车会跨回调保留，使拆分的 CRLF 合并为一个换行。

取消发送时，系统会先把排队输入标记为已取消，再要求终端句柄向当前前台进程组发送真正的 `SIGINT`；异步写入前检查即使随后结算，也无法执行该输入。如果提供方写入已在途，信号发送会等待其结算；写入被拒绝时不会发送信号。已取消的 send 会保留其位置，直到写入与前台信号发送都结算，因此后继 send 不会收到延迟字节或该信号。因此，永不结算的提供方写入或信号会无限期保留该位置；恢复手段是关闭会话（`terminal_close`）。取消等待期间，绝对 deadline 仍保持启用。信号发送失败是终端传输失败，会拒绝活跃 send。取消绝不会通过写入 `\x03` 模拟中断，因此，即使程序运行在 raw 模式下，也仍可取消。关闭操作会拒绝新的公开信号、停止就绪轮询，并等待由句柄提供方负责的完整会话终止，然后才把活跃 send 结算为 `session_exit`。

<a id="understand-the-implementation"></a>
## 理解实现

本插件组合沙箱解析、方言引导、标记与静默就绪、有界读取、取消和提供方负责的清理；上方插件说明是操作实现参考。

<a id="further-exploration"></a>
## 进一步探索

- [terminal 包映射](../README.zh.md)——持久 PTY 能力家族。
- [持久 bash 工具](../../shell/tool-bash-persistent/README.zh.md)——使用此后端的模型侧消费方。
- [持久 pwsh 工具](../../shell/tool-pwsh-persistent/README.zh.md)——PowerShell 消费方与回退输出约定。

<a id="model-experience"></a>
## 模型体验

### 当前文件策略与间接消费方

#### 模型看到的内容

策略归属方会贡献与具体能力无关的 `sandbox:policy` 上下文。模型通过 `@deepseek-ai/dsh-tool-terminal` 或其他 PTY 消费方还可能收到有界的 MOTD、发送增量、scrollback 页、就绪原因和清理错误。

#### Token 影响

装载该后端期间，当前策略子句会一直存在。消费方返回有界输出前，保留的 PTY scrollback 不会进入模型历史。

#### KV Cache 影响

常驻策略发生变化时，会在保留的历史之后追加一份由归属方渲染、取代先前状态的运行时上下文快照；消费方结果保持仅追加。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 输出按行规范化；不支持全屏备用缓冲区交互。
- 精确 stdin 等待检测取决于已挂载的进程管理提供方。启动发布 shell 后，普通 send 在提供方无法证明 stdin 等待时可以使用提示符标记和静默／超时就绪机制。Windows 正是这样的提供方：shell pid 是伪前台进程组，没有精确的 stdin-wait 档，因此无标记的前台子进程会让普通 send 按静默上限结算。
- pwsh 引导（UTF-8 编码钉与 `prompt` 函数）通过 `[Console]::` 写入，Windows ACL 沙箱的只读模式（ConstrainedLanguage）可能拒绝它。具备精确 stdin 等待证据的提供方仍可在没有标记的情况下完成启动，但非 ASCII 输出可能沿用宿主代码页。Windows 没有精确 stdin-wait 档，因此其启动会在绝对 deadline 处拒绝，而不会发布提示符设置遭拒的 shell。
- 清理保证以 `SubprocessTerminalHandle` 的保证为准；提供方特定的缺口属于该实现的约定，而非这个 PTY 消费方。
- harness 进程退出后，会话无法继续存在。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无密钥 fixture 覆盖方言引导、就绪、取消、有界读取、沙箱模式限制与提供方清理。依赖 PowerShell 的组合覆盖由平台 CI 负责。

</details>

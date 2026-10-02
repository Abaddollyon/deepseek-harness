# Agent Note: 预设拥有的执行环境

Status: implemented

[English](2026-10-02-preset-owned-execution-worlds.md) | 中文

## Problem

[SSH 执行提供方](2026-09-11-posix-ssh-runtime.zh.md)为一个组合提供远端文件系统与进程环境，但 Web 将所有面向模型的工具组合在 Agent 预设内。挂载在预设 `isolate` 组内的 SSH 环境对代表 Session 行事的 Host 消费方不可见：Session 创建会在 Host 上创建 cwd，Files 侧栏列出 Host 路径，Terminal 侧栏启动 Host shell，且 Session 的每个子 agent 都加入父级预设，因此一个父级无法在不同主机上启动子 agent。

## Decision

隔离了 `fs`、`subprocess`、`sandbox` 及使用它们的工具的 Agent 预设即为一个执行环境。Host 消费方通过预设注册表而非自身注入来访问该环境：

- `agentPresets.serviceForPreset(id, name)` 在任何 Agent 加入之前读取预设当前修订在 `isolate` 域内发布的服务；`serviceFor(agent, name)` 仍是面向活动 Agent 的形式。
- 若预设挂载了自己的 `fs`，Session 创建通过该 `fs` 检查 cwd。目录必须已存在于该环境中，且不会在 Host 上创建任何内容；其他预设保留 Host 上的 `mkdir`。
- `workspace-files` 通过 Session 投影所指定预设的 `fs` 读取，因此空白 Session 切换预设后同样生效。`terminal-controller` 通过 Agent 预设隔离的 `subprocess` 启动进程。
- `tool-fs-search` 接受 `rgPath`，因为打包的 ripgrep 二进制是 Host 路径。
- 工作区记录可指定 `agentPreset`；其路径通过该预设的 `fs` 规范化，并按（预设，路径）保持唯一。`workspace-controller` 在注册表上安装这些路径环境，在此类工作区中创建的 Session 以其预设启动。
- 子 agent 可通过 `ChildExecutionTarget` 在另一个预设和 cwd 下运行，该目标由进程内提供方提供（`startInProcessRun` 选项或 `ContinuableCreateSpec.target`）。子 agent header 记录二者；当 header 预设与父级不同时，`applyChildComposition` 挂载 header 预设，因此冷恢复会重新加入同一环境。工作流 `agent()` 通过 `subagentProvider` 按子 agent 选择此类提供方。

若部署希望工作流脚本本身在远端运行，则在同一 isolate 组内挂载 `ptc-runtime-node`（含已安装的 bootstrap）、`workflow-ptc` 与 `tool-workflow`；Host PTC 运行时无法在仅存在于远端的 cwd 中启动进程。

## Alternatives considered

**在每台远端主机上运行完整 Harness 并代理其 Web 客户端。** 本地 Harness 停止时远端工作仍可继续，但需要远端安装、每台主机上的提供方凭据、隧道以及第二个客户端运行时。本地预设将模型访问、审批与 Session 存储保留在同一个 Host 中。

**保留 Host `mkdir` 并创建对应的本地目录。** 这会留下多余的 Host 目录，且对于 Host 用户无法创建的路径（例如 `/root/x`）会失败。

**由父级工具调用选择子 agent 预设。** 面向模型的预设参数会在每个委派 schema 中暴露部署拓扑。由提供方携带目标，现有 `subagent` 与工作流 schema 保持不变，部署通过提供方命名主机。

## Consequences

代表 Session 行事的消费方必须向注册表请求预设拥有的服务；直接注入 `fs` 或 `subprocess` 的消费方仍只看到 Host。`workspace-files` 在每次作用域查找时观察 Session 投影。预设修订损坏时，位于该预设上的工作区会报告目录缺失，直到预设恢复。上游 `SshConnection` 不会重连：传输中断后，该预设修订的所有操作都会失败，直到部署重新建立连接。

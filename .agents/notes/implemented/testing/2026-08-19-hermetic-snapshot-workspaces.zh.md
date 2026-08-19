# Agent Note: Hermetic workspaces for keyless snapshot scenarios

Status: implemented

[English](2026-08-19-hermetic-snapshot-workspaces.md) | 中文

## Problem

无密钥快照场景在生成的工作目录中启动真实的应用子进程，并将其持久化会话日志与签入的 golden 做 diff。该生成目录隔离了 `DSH_HOME` 和 `DSH_AGENTS_HOME`，但仍有两类模型可见输入是通过从该目录**向上**遍历发现的：工作区指令（`dsh-agent-instructions` 向上寻找第一个 `.git`，并从那里向下读取每个 `AGENTS.md` / `CLAUDE.md`）和 skill 根（`dsh-skill-filesystem` 以同样方式向上遍历，然后扫描 `<projectRoot>/.dsh/skills` 和 `<projectRoot>/.agents/skills`）。子进程还继承了完整的父进程环境，包括开发者 shell 中导出的任何 `DSH_*` 部署变量。

在平台临时根目录下，这种向上遍历通常什么也找不到，因此泄漏一直不可见。`session-sandbox-root` 场景刻意将其工作区放在 `os.homedir()` 下——它检验的正是沙箱根来自 `SessionHeader.cwd` 而非进程级临时目录回退——而开发者主目录本身若是一个 Git 仓库，就会把整个主目录变成项目根。那次运行记录了两个额外的 `user/message` 事件（主目录 `AGENTS.md` 和由 `~/.dsh/skills` 构建的 skill 目录清单），使其后每个 `seq` 偏移，整份日志比较失败。两种可选做法都是错的：重新录制会把某一台机器的 skill 列表签入仓库，不录制则会让该套件在这台机器上保持红色而在别处保持绿色。

## Decision

隔离工作区是封闭性的单位，[`dsh-loader-smoke`](../../../../packages/test-support/loader-smoke/README.md) 为两个子进程 harness 拥有该约定。

`anchorWorkspaceProjectRoot` 在任何 fixture 播种之前，于生成的 cwd 内创建 `.git` 项目根标记。指令查找和 skill 查找都在此终止，因此工作区父目录不贡献任何内容，指令显示路径也保持相对于工作区。选择 `.git` 作为标记，是因为它是 `projectRootMarkers` 的默认值，也是 `dsh-skill-filesystem` 唯一识别的名称；把标记放在 cwd 之外会使项目根位于其上方，并将一个生成的目录名带入模型可见的显示路径。

`isolatedSubprocessEnv` 将子进程环境组装为：继承环境减去每个 `DSH_*` 条目，再叠加本次启动自身的条目。宿主变量（`PATH`、`HOME`、`NODE_OPTIONS`）仍然透传；部署值由测试声明。`runLoaderSmoke` 和 `launchAcpTestAgent` 同时应用两者，因此 ACP、headless 和 `apps/cli` 快照车道共享同一项保证。

需要指令或 skill 的场景将它们声明为场景数据：指令用 `workspace/AGENTS.md`（`agent-instructions` 与 `code-mode-workspace-context` 场景），skill 用 `workspace/.dsh/skills/<name>/SKILL.md`（`skill-load` 场景），或由组合指定仓库拥有的 skill 目录（`dsh-badge` CLI 场景）。没有任何场景依赖宿主机的环境内容；`session-sandbox-root` 是意外吸收，而每个断言 skill 或指令的场景都已声明了自己的来源。

## Testing

`runScenario` 的工作区列表 fixture 现在把该标记显示为第一个条目，这正是 anchor 存在的证据。`loader-smoke` 覆盖 anchor 的幂等性、环境组装，以及一次端到端运行——其子进程看到空工作区且没有导出的 `DSH_*` 值；`acp-snapshot` 覆盖环境中的 `DSH_PERMISSION_MODE` 无法到达子进程。回归本身由 `session-sandbox-root` 固定：加入 anchor 之前它在这台机器上因两个额外的 `user/message` 事件而失败，加入之后签入的 golden 无需改动即可匹配。

## Related

[ACP 快照 Agent Note](2026-06-19-acp-snapshot-tests.md) 拥有快照层的 fixture 角色与 record/replay/refresh 语义；[workspace-context Agent Note](../feature/2026-06-24-workspace-context.md) 拥有指令查找，本工作区 anchor 限定了它的向上遍历。

## Alternatives considered

**把这些额外事件归一化掉。** 丢弃指令或 skill 提醒的 normalizer 会隐藏模型实际接收内容中的真实回归，而“模型可见 ⟺ 已记录”不变量使这些事件具有承载作用。仓库政策是修 fixture，而不是修 normalizer。

**在录制机器上重新录制 golden。** 这会使签入的日志成为某位开发者已安装 skill 和主目录指令的快照；CI、全新克隆以及每位同事随后都会与它不一致。

**把该场景的工作区移回临时根目录下。** 该场景的存在正是为了证明位于始终可写的临时根之外的工作区仍能通过 `SessionHeader.cwd` 写入；移动它会删除这份覆盖。而且它也只会为其他每个场景掩盖同一类泄漏。

**给场景一个隔离的父目录，把标记放在上一层。** 查找会停在 harness 拥有的范围内，但项目根将不再等于会话 cwd，因此指令显示路径会带上生成工作区的目录名——这是模型可见文本中的一个随机值。

**保留一份转发的 `DSH_*` 变量白名单。** 车道选择器（`DSH_SNAPSHOT`、`DSH_EXAMPLE_MODE`）是仅有的合理条目，而两者都在父测试进程中解析或按场景声明。白名单会恰好保留本次改动所消除的那种含混。

## Consequences

每个隔离子进程工作区现在都包含一个 `.git` 目录。它对搜索工具的默认列表是隐藏的，且没有场景枚举工作区根，因此没有任何签入的 golden 发生变化；发生变化的是 harness 自身的 `readdirSync` 回显 fixture，而这种可见性正是 anchor 的证据。丢弃继承的 `DSH_*` 意味着依赖环境转发的测试必须显式声明该变量，而未声明 `DSH_SNAPSHOT` 的场景现在总是启动其配置中的非快照分支，而不再跟随开发者的 shell。

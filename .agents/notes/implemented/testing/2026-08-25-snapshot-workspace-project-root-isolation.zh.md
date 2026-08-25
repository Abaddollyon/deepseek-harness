# Agent Note：快照测试宿主锚定工作区项目根发现

Status: implemented

[English](2026-08-25-snapshot-workspace-project-root-isolation.md) | 中文

## Problem

无密钥快照回放会在生成的临时 cwd 中启动真实的 agent 组合，而工作区指令发现（AGENTS.md/CLAUDE.md）与项目技能发现都会从会话 cwd 向上遍历，直到第一个含有项目根标记（默认为 `.git`）的目录。每个快照宿主都把 `DSH_HOME` 和 `DSH_AGENTS_HOME` 固定在生成的 cwd 内，却没有约束这段向上遍历：当开发者的 home 目录本身是一个 git 检出——或 TMPDIR 位于其中——回放就会把该宿主祖先当作项目根：宿主的 AGENTS.md 以基线 `agent-instructions` 用户消息进入日志，宿主的 `.agents/skills` 以 `skill-catalog` 消息进入日志。回放与夹具内容逐字节一致，仅 `sourceEventSeqs` 因多出的事件而偏移，于是文档记载的命令（`pnpm run test:snapshot`）在干净检出上因纯粹的环境原因失败，而 CI（检出上方没有带标记的祖先）却通过。

acp-agent 的 `session-sandbox-root` 场景把这一泄漏从偶发变成必然：它故意在用户 home 下生成 cwd（`workspaceParent: homedir()`），因为被测的正是临时目录授权本身，所以每位把 home 纳入 git 的开发者都会复现。

## Decision

`@deepseek-ai/dsh-loader-smoke` 中的 `isolateWorkspaceProjectRoot(cwd)` 在进程启动前向宿主拥有的隔离 cwd 播种一个空的 `.git` 标记目录，使向上发现遍历终止于 cwd 本身。cwd 成为自己的项目根，发现只能看到场景播种的文件：真实接缝在受控工作区内保持启用，与 web 回放脚手架把每个宿主级技能根固定在临时目录内的做法（scaffold-hermetic.e2e.ts）一致。

每个创建隔离示例 cwd 的宿主都调用它：`runLoaderSmoke`（headless 与 CLI 快照套件）、`runScenario`（ACP 快照套件，在工作区播种之后），以及经 `dsh-acp-snapshot` 转出口调用的进程内 web 回放脚手架。标记是空目录，与真实检出的形态一致；点号前缀的条目对不带 `-a` 的 `ls` 和 基于 ripgrep 的 glob 默认行为不可见，因此任何已提交夹具都不会扰动。record 模式同样播种标记，使录制与回放在录制机器上保持对称。

## Alternatives considered

- **重录夹具或停止比较 `sourceEventSeqs`**——掩盖泄漏，并削弱捕捉真实事件数回归的比较；夹具本身正确，是宿主在泄漏。
- **在回放组合中禁用 agent-instructions 行**——web 脚手架正是这么做的，但 ACP 套件带有以指令加载为主题的场景（agent-instructions、code-mode-workspace-context），一概禁用会删掉这部分覆盖。
- **面向宿主的环境变量或配置覆盖来约束发现遍历**——为宿主关切新增产品表面；覆盖 `projectRootMarkers` 的组合本已拥有自己的发现语义，而环境变量会绕过组合层。
- **按场景打回放 overlay 补丁**——未来的场景与其他宿主仍然不受保护；封闭性属于 cwd 的创建者，而非各场景。

## Consequences

- fake-agent 宿主规格通过 `readdir` 回显工作区，因此其断言现在显式列出 `.git` 条目，把标记钉为宿主行为。
- 场景无法再观察其生成 cwd 上方的真实父项目根；也从未有过——场景工作区都是自包含的，`workspaceParent` 场景仍保留其显式父目录用于沙箱授权覆盖。
- 在 web 回放脚手架中 agent-instructions 行被整体禁用，因此标记仅针对带标记 TMPDIR 守护项目技能根；那里的指令隔离仍由禁用承担。

## Testing

- acp-agent 快照通道新增回归测试：在含有 `.git` 标记、哨兵 AGENTS.md 与哨兵 `.agents/skills` 包的祖先目录下回放 `text-turn`，断言两个哨兵都不进入回放日志；没有标记播种时，它恰好以两条宿主事件失败。
- loader-smoke 单元测试断言隔离 cwd 在清理前存在标记目录。
- 验证：`pnpm run test:snapshot`、`pnpm run typecheck`、`pnpm run build`。

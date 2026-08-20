# Agent Note: 统一会话 Agent 流程

Status: implemented

[English](2026-08-20-unified-session-agent-flow.md) | 中文

## 问题

Web 客户端原有 subagent 目录操作，但没有一个会话级视图把保留的 subagent 摘要、按需加载的成员目录、谱系诊断、提供方／模型身份、token 用量、耗时和嵌套导航合并起来。外部 Swarm 贡献提供了一个竞争性的持久化 swarm 视图，因此核心视图需要一个明确的注册与所有权决策来避免重复视图。

## 决策

@deepseek-ai/dsh-client-ui-subagent 拥有一个 `conversation.view` 注册，持久化 id 为 `swarm`，本地化 label 为 `subagent.view.swarm`，order 为 25。注册通过 `ctx.slots.inject('conversation.view', () => ctx.slots.register(...))` 完成，因此贡献跟随声明 slot 的生命周期，并在插件 fiber 销毁时移除。本包继续拥有页头目录操作、只读 composer chain 和 @ 输入 source。

## Source audit 与所有权

Source audit 找到了标准 `useSessions` snapshot 及其 `byId`、`subagentsByParent` 和 `ids`，运行时谱系索引 `indexSubagentDescendants`，按需目录方法 `setSubagentCatalogOpen` 和 `refreshSubagents`，以及现有的会话级 `conversation.view` slot。本包已经拥有目录、诊断、导航 callback、本地化 namespace 和已发布的 Web entry，因此该流程是该 owner 的呈现扩展，而不是第二个目录或 runtime store。

Source audit 还确认客户端谱系字段是 `SessionSummary.parentId`，而目录导航地址是派生值。`ui-workflow-run` 仍然拥有 workflow Conversation Definition 和 keyed Chat renderer；流程不导入其 renderer、definition 或 panel。

## 数据权威与合并优先级

AgentFlowView 通过同一个 framework 提供的 `useSessions` source 读取 `byId`、`subagentsByParent` 和 `ids`。父级已被表示的 subagent-origin 摘要是谱系与生命周期权威；即使其后代具有 subagent origin，普通 fork 仍然终止 subagent 树。`ids` 只用于普通打开回退，并依赖宿主列表排除 addressed subagent 行这一不变量，而不是把原始 ids 当成普通来源证明。

纯模型只索引一次 subagent-origin 摘要，以稳定的 source 顺序合并每个 parent 的目录，并让摘要生命周期与 projection 值优先。健康目录条目提供 mode、label、直接或聚合 activity、子级提示和目录先到的占位行；child 地址由目录 parent key、健康 child id 和 mode 推导。摘要行没有当前目录条目时，优先使用保留的 `sessions.subagentAddress`。诊断条目永远不会得到地址。

摘要落后时，模型保留目录先到的健康 child 计数，而聚合运行数继续以摘要为权威。只有目录的行先使用 direct activity，再使用 aggregate activity。只有摘要的行在有效目录或保留地址出现前保持为禁用的 loading 行；只有当摘要是符合条件的非 subagent 宿主列表行时，它们才可以请求刷新并使用普通打开。

## 按需观察、清理、诊断、循环与孤儿

挂载时观察当前会话的目录。展开分支时只观察该 child parent；收起分支时关闭它及所有被观察的后代；会话切换和卸载通过最新 callback ref 关闭其余所有被观察的 parent。不存在 polling，也不会在挂载时加载所有层级。

健康目录条目、摘要行、loading 行、目录加载错误以及 corrupt、unsupported、unavailable 诊断保持为不同的稳定行。诊断、loading、cycle 和 orphan 情况不能创建打开操作。检测到循环时以本地化谱系诊断停止该分支；孤儿摘要在其 parent 被表示前不进入根树，但仍可安全参与聚合索引。

## Metrics 与 render-cost 约束

Token 总计是互不重叠的 `uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` 之和。模型身份使用 `modelRoute.provider` 与 `modelRoute.model`；部分 route 显示已知一侧，另一侧显示不可用；`agentPreset` 只有在明确标为 preset 回退时才显示。缺少 projection 时显示本地化的不可用值，而不是伪造零值。

活跃耗时是 `subagentTiming.settledMs` 加上活跃区间；运行中的区间以共享当前时钟结束，已结束或非活跃区间以 `active.through` 结束。流程只报告 running 或 settled。`SessionSummary cannot report durable success/failure outcome`；因此 UI 不声称成功、失败、取消或完成。

一个组件级单秒时钟服务所有可见的活跃行。结构、目录和摘要模型事实独立于时钟进行记忆化；只有活跃耗时呈现接收变化中的时间值，因此已结束行保持稳定的渲染输入。流程只挂载根层和明确展开的层级，不为每行创建 timer 或 subscription。

## Slot 注册与外部 Swarm 迁移

核心包通过声明的会话级 slot 为每个会话注册 `swarm` 视图，包括空会话。外部 `@arro/dsh-swarm-ui` 贡献是由 orchestrator 拥有的发布前置条件：发布这个核心注册前必须移除或禁用它。本核心变更不编辑 extensions worktree、profile、部署 composition、installed runtime、service 或 port 3080。

## WorkflowRunPanel 保留与 patch-anchor audit

现有 Chat workflow card 仍由 `@deepseek-ai/dsh-client-ui-workflow-run` 中的 `WorkflowRunPanel` 拥有。Swarm 流程只是索引和导航视图：它打开 child 会话，不复制 workflow run、phase、member、结果或 disclosure 状态。ui-workflow-run source 与 tests 未因本功能修改。

对 `/home/arro/coding/deepseek-harness-extensions/patches/manifest.json` 的只读 audit 找到了 patch id `apply-rc6-workflow-card`，目标为 `dsh-client-ui-workflow-run/lib/client.js`。两个受保护的 find 字符串均精确匹配一次，replacement 保持不变：

~~~json
{
  "find": "\t\tif (member.status === \"running\" && ordinary.has(member.childId) && summary?.origin === \"subagent\" && summary.parentId === parentId && summary.running) result.push(member.childId);",
  "replace": "\t\tif (ordinary.has(member.childId) && summary?.origin === \"subagent\" && summary.parentId === parentId && (summary.running || member.status !== \"running\")) result.push(member.childId); // rc6-workflow-card patch",
  "count": 1
},
{
  "find": "\t\t\t\tstatus: member.outcome === void 0 ? interrupted ? \"interrupted\" : \"running\" : statusFromOutcome(member.outcome)",
  "replace": "\t\t\t\tstatus: member.outcome === void 0 ? (interrupted || locationClosed(location) ? \"interrupted\" : \"running\") : statusFromOutcome(member.outcome)",
  "count": 1
}
~~~

两个受保护的 find 值及其 replacement 与外部 manifest 完全一致，且各自 count 为 1。没有编辑 extension 文件或 patch manifest，本核心功能不需要任何 patch replacement。

## 曾考虑的替代方案

**保留外部 Swarm 视图，只增加核心数据 helper。** 否决，因为两个 Swarm 注册会重复持久化视图并使所有权不明确。现在核心包拥有视图，发布时由 orchestrator 负责禁用外部贡献。

**新增 view id，而不是复用 `swarm`。** 否决，因为持久化视图身份与现有导航使用 `swarm`；新 id 会创建第二个 surface，而不是替换外部视图。

**增加 runtime 谱系 service 或每个 child 的 RPC。** 否决，因为同一个 `useSessions` snapshot 已经包含摘要谱系和按需目录。仅用于呈现的 projection 不值得把业务数据移入 runtime，也不值得每行增加一次请求。

**只使用目录，或在结构模型中计算实时耗时。** 否决，因为目录先到的行可能早于摘要 hydration，而时钟 tick 会重建每个结构行。实现合并两类来源，并隔离动态耗时呈现。

**所有行都通过 `openSession` 打开。** 否决，因为目录 child 必须使用确切的 parent/child/mode 地址和 `openSubagent`；普通回退仅受宿主列表排除不变量限制。

## 后果

流程对每个会话可见，并使用明确的空状态，而不是成员数阈值。健康目录 child 会在 `byId` 追上前显示，诊断保持可见但不可导航。视图无需新增 subscription 或 RPC 即可显示提供方／模型以及可选的用量、耗时和统计事实。

聚合运行数保持摘要权威，因此只有目录的运行中 child 可以先显示运行中的行状态，摘要聚合数随后才追上。目录加载失败会增加一个可重试但不可交互的行。根目录与展开 parent 的观察状态保留在组件本地，并在 teardown 时关闭，避免会话切换后遗留打开的成员订阅。

外部发布前置条件仍属于运维工作：在 orchestrator 禁用 `@arro/dsh-swarm-ui` 前，部署 composition 不能同时挂载两个注册。核心包不拥有外部迁移，也不能从本仓库验证已部署 composition。

## 测试与 snapshot evidence

`packages/client/ui-subagent/tests/agent-flow.client.spec.tsx` 使用 `createSnapshotStore` 与 `bindSnapshotSelector` 覆盖空会话、嵌套摘要／目录合并、目录先到时的聚合回退、token bucket 求和、active-through 耗时、loading 占位、诊断、重试、按地址导航、无障碍元数据和循环阻止。`packages/client/ui-subagent/tests/browser-plugin.client.spec.ts` 启动真实 `SlotRegistry`，验证 Swarm 注册与注入导航 face，并证明 fiber 销毁会移除视图。聚焦回归命令继续包含 conversation UI 与 workflow-run 套件。

组装后的 keyless browser evidence 使用客户端构建后的 `DSH_SNAPSHOT=replay pnpm run test:web`。只有当 reviewed diff 是 tab strip 中注册的 Swarm tab 或新的 Swarm flow view 时才使用 refresh；replay fixture 与无关 golden 保持不变。built-boot official-brand mismatch 是唯一预期失败，因为该 official-brand 场景预先存在，不能刷新它。

View-level evidence 包括 Swarm tab 注册与 component flow fixtures；现有 WorkflowRunPanel regression 独立保留，因为 workflow 细节仍在 Chat。本次 refresh 精确写入 41 个文件：`apps/web/tests/snapshots/bash-abort-row/ui.expected.md`、`apps/web/tests/snapshots/code-mode-round/ui.expected.md`、`apps/web/tests/snapshots/cordis-tool-round/ui.expected.md`、`apps/web/tests/snapshots/feedback-command/ack.expected.md`、`apps/web/tests/snapshots/fresh-round-trip/ui.expected.md`、`apps/web/tests/snapshots/goal-command-presentation/ui.expected.md`、`apps/web/tests/snapshots/goal-multi-turn-actions/ui.expected.md`、`apps/web/tests/snapshots/lifecycle-chrome/reloaded.expected.md`、`apps/web/tests/snapshots/live-interactions/cancel.expected.md`、`apps/web/tests/snapshots/live-interactions/error-auth.expected.md`、`apps/web/tests/snapshots/live-interactions/loading.expected.md`、`apps/web/tests/snapshots/live-interactions/retry.expected.md`、`apps/web/tests/snapshots/markdown-cjk-strong/ui.expected.md`、`apps/web/tests/snapshots/markdown-images/ui.expected.md`、`apps/web/tests/snapshots/markdown-inline-code-links/ui.expected.md`、`apps/web/tests/snapshots/math-rendering/ui.expected.md`、`apps/web/tests/snapshots/message-actions/ui.expected.md`、`apps/web/tests/snapshots/plan-review/approved.expected.md`、`apps/web/tests/snapshots/question-composer/answered.expected.md`、`apps/web/tests/snapshots/queue-actions/collapsed.expected.md`、`apps/web/tests/snapshots/queue-actions/editing.expected.md`、`apps/web/tests/snapshots/queue-actions/layout.expected.md`、`apps/web/tests/snapshots/queue-actions/preserved.expected.md`、`apps/web/tests/snapshots/queue-actions/ui.expected.md`、`apps/web/tests/snapshots/reference-composer/order.expected.md`、`apps/web/tests/snapshots/seeded-history/command-row.expected.md`、`apps/web/tests/snapshots/seeded-history/feedback-row.expected.md`、`apps/web/tests/snapshots/seeded-history/ui.expected.md`、`apps/web/tests/snapshots/skill-tool-row/ui.expected.md`、`apps/web/tests/snapshots/skill-user-invoke/ui.expected.md`、`apps/web/tests/snapshots/stats-paged-history/ui.expected.md`、`apps/web/tests/snapshots/steer-all/mid-steer.expected.md`、`apps/web/tests/snapshots/steer-all/settled.expected.md`、`apps/web/tests/snapshots/steering/mid-steer.expected.md`、`apps/web/tests/snapshots/steering/settled.expected.md`、`apps/web/tests/snapshots/subagent-conversation/nested.expected.md`、`apps/web/tests/snapshots/subagent-conversation/ui.expected.md`、`apps/web/tests/snapshots/subagent-interrupt/offline-composer.expected.md`、`apps/web/tests/snapshots/turn-tail-actions/running.expected.md`、`apps/web/tests/snapshots/turn-tail-actions/settled.expected.md` 和 `apps/web/tests/snapshots/web-search-round/ui.expected.md`。每个 hunk 只在原有 tabs 之间增加 `tab "Swarm"`；没有 flow-view body、JSONL fixture 或其他无关内容变化，built-boot official-brand golden 也保持未刷新。

## Supersession 与未改变行为

本功能扩展以下决定，但不改变它们的 runtime 或 durable contract：

1. [Durable subagent catalog and list_agents](2026-07-22-durable-subagent-catalog-and-list-agents.md) — **扩展：** 客户端在嵌套会话视图中呈现目录健康 child 与诊断。**未改变：** 目录条目类型、诊断原因、稳定 child 身份和面向模型的 list 行为。
2. [Web subagent conversations](2026-07-27-web-subagent-conversations.md) — **扩展：** 现有目录与导航 owner 现在提供会话级 Swarm 索引。**未改变：** addressed 导航、one-shot 只读行为、composer 路由和离线限制。
3. [Continuable subagent conversations](2026-07-28-continuable-subagent-conversations.md) — **扩展：** 流程在已 hydration 的深度显示 one-shot 与 continuable 后代。**未改变：** Activation、inbox、确切直接 parent 授权和 continuation 生命周期。
4. [Continuable subagent interrupt](2026-08-06-continuable-subagent-interrupt.md) — **扩展：** running/settled 呈现识别存活 child，但不增加控制。**未改变：** 专用 interrupt 路由、one-shot 不可取消性和 Stop/Send 行为。
5. [Durable workflow runs in Chat](2026-08-10-durable-workflow-runs-in-chat.md) — **扩展：** 当前会话事实允许时，workflow worker 成为可导航的索引行。**未改变：** durable workflow events、member eligibility 和原始 tool row。
6. [Workflow-run status-driven disclosure](2026-08-11-workflow-run-status-driven-disclosure.md) — **扩展：** Swarm 视图链接到 Chat drill-in。**未改变：** WorkflowRunPanel disclosure 状态以及 phase/status 派生。
7. [Workflow per-agent reasoning effort](2026-08-19-workflow-per-agent-reasoning-effort.md) — **扩展：** 流程可以显示产生的提供方／模型身份，同时保留现有 workflow route。**未改变：** 每个 agent 的 reasoning-effort 选择、校验和 worker 执行。
8. [Conversation render cost bounds](../architecture/2026-08-19-conversation-render-cost-bounds.md) — **扩展：** 流程使用稳定结构行和单个活跃耗时钟遵循共享 render-cost 规则。**未改变：** conversation 包已有的 cache bounds、settings 和 scroll/render contract。
9. [Subagent list identity via the projection unit](../architecture/2026-08-06-subagent-list-identity-projection.md) — **扩展：** 流程使用已发布的 subagent identity projection 进行 mode 与 label 优先级处理。**未改变：** projection fold 权威、诊断映射、序列校验和 compute-and-discard 策略。

这些链接记录本视图扩展的既有决定；本变更不编辑或归档其中任何 note。

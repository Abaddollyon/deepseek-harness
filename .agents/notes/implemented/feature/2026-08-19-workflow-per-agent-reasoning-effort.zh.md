# Agent Note: 工作流中按 agent 的推理等级

Status: implemented

[English](2026-08-19-workflow-per-agent-reasoning-effort.md) | 中文

## Problem

工作流脚本此前已能把某次 `agent()` 调用指向任意已注册提供方及该提供方服务的任意模型，却无法指向某个推理等级。该选项被按名拒绝：`effort` 与 `isolation`、`agentType` 一同位于 worker 运行时的延迟集合中，面向模型的工具描述也承诺它会「被明确拒绝」。因此，即便自[适配器拥有的推理等级能力](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md)起 LLM seam 就已端到端校验按调用的推理等级，起草／校验型脚本仍无法在抽取阶段花费廉价等级、在对抗性复核阶段花费昂贵等级。

被拒绝并不是唯一的缺口。委派已用来把 `provider` 和 `model` 送达子 agent 的通道 `AgentOptions` 没有推理等级字段，而 loop 只从 `provider`、`model` 和 `maxTokens` 播种请求配置。在不填补该缺口的情况下于脚本侧接受推理等级，会正好制造出本仓库禁止的「被接受后被忽略」失败模式。

## Decision

`agent(prompt, { provider, model, reasoningEffort })` 选择子 agent 完整的 LLM 目标，三个字段可独立设置：只传其中一个的调用，另外两个仍沿用父 agent 的取值。

### 名称定为 `reasoningEffort`

脚本选项是写在同一个对象字面量里、与 `provider` 和 `model` 并列的 JavaScript 标识符，因此拼写沿用该选项所设置的 seam 类型 `LlmCallConfig.reasoningEffort`，而不是工具 JSON 参数会采用的 snake_case。Claude Code 的裸名 `effort` 被否决：它没有指明任何维度，而且复用它会让原本表达 Claude Code 选项的脚本悄悄变成另一种含义。于是 `effort` 也不再属于**延迟**：它只是本引擎不存在的名称，其拒绝信息现在会列出受支持集合，其中包含 `reasoningEffort`。`isolation` 和 `agentType` 仍被延迟并按名拒绝。

### 是拒绝而非替换，且发生在子 agent 存在之前

对于显式推理等级，`LlmRuntime.resolveCallConfig` 就是本仓库既有的策略：确切模型未提供的推理等级会以 `UNSUPPORTED_REASONING_EFFORT` 被拒绝，不做钳制或别名替换。它唯一的替换是为未请求推理等级的调用方物化**适配器默认值**，那是另一种情形，并非降级。本次改动沿用该策略，而不是另立一套。

校验在宿主侧、于 `WorkerRun.startChild` 中、在 `SubagentRuntime.start` 之前运行。它所针对的路由与 subagent seam 的解析方式完全一致：有按调用覆盖时用覆盖值，否则用继承的父路由。因此单独传入的推理等级会针对它真正会作用到的目标被校验，而与 `provider`／`model` 一同传入的推理等级会针对被覆盖后的路由被校验。拒绝、路由不完整，或部署未组合 LLM 能力，都会成为致命的 `AGENT_START` `WorkflowError`，并由组合器重新抛出。

在宿主而非子 agent 中校验正是关键。抵达不支持该等级的子 agent 的推理等级会让该子 agent 的回合失败，而失败的子 agent 恰恰是 `agent()` 向脚本报告为 `null` 的情形——与模型拒绝任务无法区分。按调用的推理等级若可能消解为 null，或更糟地被悄悄降级，工作流的成本与质量就不可预测。

该能力通过 `ctx.get('llm')` 读取而非注入：引擎仅在校验推理等级时需要 LLM 服务，从不传入推理等级的部署运行方式保持不变。

### 落到子 agent 的方式

seam 通过模块增强声明 `AgentOptions.reasoningEffort?: ReasoningEffortId`，与 `AgentOptions.subagentDepth` 已采用的机制相同，因此推理等级搭载承载 `provider` 和 `model` 的 `agentOptions` 通道，无需新增 `SubagentCapabilities` 标志。

由于 loop 不会从 `AgentOptions` 播种推理等级，改由 `applyChildComposition` 安装它：借助 `bundle/headless` 与 API proxy 已为此用途使用的 `installModelSelection` 助手，把它作为 Agent 作用域的模型选择安装到子 agent 自己已解析的路由之上。该函数因此新增第四个参数（已解析的 `AgentOptions`），理由与它接收父级相同：让「组装子 agent 却不带其推理等级」在各调用点无法表达；两条进程内组装路径（一次性驱动与继续执行管理器）都经由它。若推理等级没有完整路由可应用，则在创建窗口内抛出，从而使启动被拒绝而不是把它丢弃。

### `meta.phases` 同样携带该字段

阶段声明已标注其 agent 预期使用的 `provider` 和 `model`。这些标注只是信息性的，新增第三个也没有运行时消费者——但提供方、模型和推理等级如今构成同一个可选目标，只携带其中三分之二的声明会低估该阶段成本，读起来却像是完整的。该字段与另两个同级字段一样被校验和规范化。

## Alternatives considered

- **在 agent loop 中从 `AgentOptions` 播种推理等级。** 这是结构上最干净的归属，也是顶层 agent 的推理等级应在之处。此处被否决，因为那是对 `packages/core` 请求组装的改动，影响面覆盖每个 agent；而委派作用域的选择复用了正为此用途编写的公开助手，并留在拥有子 agent 组装职责的 seam 内。
- **新增 `SubagentStartRequest.reasoningEffort` 及配套的 `SubagentCapabilities` 标志。** seam 中启动选项与能力标志一一对应的成文规则支持这种做法，它还能让无法履行推理等级的后端拒绝而非忽略。被否决为不成比例：第五个标志会迫使每个提供方、测试和能力字面量都改动，而且会让推理等级与 `provider`／`model` 不一致——后两者在完全没有标志的情况下搭载 `agentOptions`。
- **把 Claude Code 的 `effort` 作为别名接受。** 被否决：同一选项两种拼写，正是本仓库视为「遗漏抽取」的不对称；而未识别选项的信息已经指明 `reasoningEffort`，因此写出 `effort` 的模型会在下一次调用被纠正。
- **替换为最接近的受支持推理等级。** 被否决：这正是本特性要避免的失败，也会与 LLM seam 的策略构成两套相互矛盾的策略。

## Consequences

工作流脚本现在可以按调用选择提供方、模型和推理等级，这正是起草／校验或委员会型脚本把预算花在关键处所需要的。两处面向模型的文本发生变化：`workflow` 工具描述与 `meta.phases` 的 schema 属性列表。

按 agent 的推理等级只对进程内子 agent 生效。随包发布的 `spawn` 后端会应用它；任何忽略 `agentOptions` 的后端都会像它已经忽略 `provider` 和 `model` 那样忽略推理等级——这包括 `acp` 后端，以及自其发布起的 `subagent-claude-code` 与 `subagent-codex` 提供方：它们驱动各自的外部 CLI，根本不从父方取用任何路由。上述每种情况下宿主侧校验仍会运行，因此请求会针对子 agent 可能并不使用的路由被检查。弥合该缺口即上文的能力标志方案。

宿主现在会触及 LLM 能力，此前并不会。该依赖是可选且仅用于推理等级的：脚本不传入推理等级的运行不会发起任何能力查询。

## Testing

`packages/workflow` 中的聚焦 vitest 覆盖了选项表面与校验策略：单独传入的推理等级针对继承路由校验；按调用的 `provider`／`model` 覆盖会改变被校验的路由；不受支持的推理等级与完全没有推理能力的模型都会终止脚本并指明路由；路由不完整；以及未组合 LLM 能力的部署。`packages/subagent/subagent-spawn-in-process` 则用真实子 agent 和真实 loop 断言这条路径的末端：子 agent 自己的模型请求携带该推理等级而父方不携带，并且无路由的推理等级会使启动被拒绝。

## Related

- [动态工作流](2026-07-05-dynamic-workflows.zh.md) 拥有本次扩展所基于的脚本约定。
- [适配器拥有的推理等级能力](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md) 拥有本次复用的校验策略。

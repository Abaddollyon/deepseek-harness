# Agent Note: Session 列表投影每一趟都发布

Status: implemented

[English](2026-08-19-session-list-projection-always-publishes.md) | 中文

## Problem

`SessionRuntime.projectList` 依据 manager 快照重建 Session 列表 store。让它投影嵌套 subagent 分支活动的同时，它也获得了按字段复用标识的能力——复用 `ids`、`byId`、行、`subagentsByParent`、`jobsBySession` 与 `currentAddress` 的引用——并随之带来一处提前返回：只要本趟投影的每个值都没变，就整个跳过 `list.set`。让 catalog 刷新不再重挂载侧栏行的是标识复用；被跳过的那次发布是另一项行为改动，它悄悄拿掉了客户端界面所依赖的一次通知。

manager 也会为那些不改变任何列表值的手势发出通知。对已经是当前会话的 `sessions.open(id)` 就是其一——`SessionManager.select` 以 `notifier.notifyNow()` 结束——而只要 `connectWorkspace` 复用当前那个空白会话而非新建，`workspaces.startSession()` 就会产生同样的情形。发布被抑制后，等待该手势的一方再也听不到它。Agent 预设设置区先把 `cordis` 暂存到 hero chip 再启动会话，而 chip 是通过自己的列表订阅来应用暂存选择的；当已连接 Workspace 的空白会话本就是当前会话时，就没有任何一方去应用这次暂存，该流程产出的会话落在部署默认预设上，而不是创造模式的组装上。

## Decision

`projectList` 总是发布：它用稳定化后的字段构造下一份状态，并在每一趟都调用 `list.set`，包括所有值都没变的那一趟。标识复用原样保留，正是它把代价框住——读取行、catalog 或 id 列表的消费方在引用未变时直接短路，因此一趟等价投影不会重挂载任何行。store 自身的去重语义不变：只有整个状态对象完全相同才跳过通知，而一趟新的投影从不满足这一点。

投影仍是列表 store 唯一的发布者，调用方也无从得知 manager 因何刷新。因此落在未变列表上的手势，与其他任何一趟投影具有完全相同的可观测性——这正是那些等待会话到位的界面所需要的。

## Testing

`packages/client/runtime/tests/sessions-service.client.spec.ts` 固定了两侧：既有用例仍要求一次等价刷新复用每个字段标识；新增用例打开已经是当前会话的那个会话，要求列表订阅者被通知一次，同时 `ids` 与 `byId` 保持原引用。

`apps/web/tests/agent-preset-authoring.e2e.ts` 端到端覆盖该流程：其创造模式场景轮询 `session.list`，要求设置区启动的那个会话带有 `agentPreset: 'cordis'`。

## Alternatives considered

**由创造模式入口直接应用暂存的预设，而不依赖列表订阅。** 该入口就得自行判断当前会话能否接受这次选择，而此时 `workspaces.startSession()`——一个发出即不管的调用——尚未解析出流程真正落到的会话。它会把组装应用到碰巧处于当前的那个空白会话上，包括连接即将离开的那一个，而 seat 控制器「已开始的会话丢弃暂存」的规则也会被搬到调用方。

**只为同步手势刷新发布，继续抑制批量收敛。** 这需要共享的 `Notifier` 告诉监听者它因何刷新，而 `Session` 也在用它；换来的节省，字段标识复用已经给了。

**保留抑制，并把创造模式的 e2e 当作已过时。** 该场景固定的是当前产品行为——一次设置区手势落到已组装好的会话上——而投影嵌套 subagent 活动并不改变该流程欠用户的东西。

## Consequences

一趟等价投影的代价是一次 `list.set` 与一次通知，因此以快照标识为键的订阅者即便什么都没动也会重渲染；其下每个字段都保持原引用，所以工作量止于那一次读取。

各界面可以重新把列表通知当作「当前会话现在也许可以承接了」来使用——Agent 预设的 hero chip，以及此后任何先暂存再启动会话的流程，都是这样够到它们落脚的会话的。

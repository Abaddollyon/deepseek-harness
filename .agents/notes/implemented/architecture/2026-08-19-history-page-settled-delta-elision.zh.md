# Agent Note: History pages omit a settled step's superseded streaming deltas

Status: implemented

[English](2026-08-19-history-page-settled-delta-elision.md) | 中文

## Problem

打开一个会话时，浏览器会收到该页区间内的全部原始事件，其中包括那些早已产出终态 `assistant/message` 的 step 的逐 token `assistant/chunk` 增量。这些增量并未重述任何读者无法从该消息读到的内容：客户端把它们折叠起来，然后在消息到达的瞬间把累积的 blocks 整体替换掉。

在本机最大的 Session（内存中 62.9 万个事件）上实测，默认 50 条消息的尾页承载了 8,779 个事件、3.02 MB JSON，其中 8,326 个事件（94.8%）是被取代的增量。`block-end` 分块重复了消息同样携带的已组装 block，而 `finish` 分块携带适配器的 `replayState`（包含加密的推理数据块），根本没有任何客户端读取它。让这一页穿过真实的 Conversation Node 流水线装配，在 React 能够渲染之前要花掉 63.4 / 38.2 / 44.2 ms 的阻塞时间，这还不算对同样字节数执行的 `JSON.parse`。

同一读取路径还为了留下几百个元素而把整个 62.9 万元素的事件数组复制了三次：一次在 `historyCutOf`，一次用于分页窗口，再一次用于 `seq >= cut` 过滤。

## Decision

`historyPage` 下发该页的一个读取路径投影：当某个 `assistant/chunk` 所属 step 的、以追加来源进入 surface 的 `assistant/message` 位于同一页更靠后的位置时，该分块被丢弃。取代关系按位置判定而非按 step 判定，这正是该性质的精确表述，并顺带给出三项保证——记录于某 step 消息之后的增量会被保留；替换副本不构成结算（它为模型重述一段被遮蔽的区间，从未进入 transcript）；页面的最后一个事件永不被丢弃，因为不可能有消息排在它之后。

最后这项保证对浏览器至关重要。`Session.loadOlder` 断言 `tail.event.seq + 1 === baseSeq`，违反即丢弃该页；`acceptLiveEvent` 把 `event.seq > tailSeq + 1` 视作空洞并重新拉取。按位置判定取代关系使页面的末尾事件仍停在 `beforeSeq - 1`，两条路径都看不到空洞；消失的只是内部的增量位置，而装配器用 `Map` 按 seq 索引它们，并不要求稠密。

有两类被取代的位置仍会下发，因为没有任何终态事件重述它们：

- 该 step 的首个 `isTokenDelta` 分块。两个 `assistant-step` Definition 以及共享的 `indexAssistantStepTiming` 折叠都从这一个事件打上 `firstTokenTime`，而 `AssistantTiming.firstTokenTime` 在 Trajectory 中对用户可见。保留首个即可原样保住该值，因为两处折叠都只取第一个、忽略其余。
- 每个 `usage` 分块。`trajectory-assistant-definition` 会跨 `llm/retry` 累加分块用量（`usage: context.state.usage ?? match.event.data.usage`），因此重试过的 step 在 Trajectory 中的总量是各次尝试之和，而终态消息自身的 `usage` 并不重述它。

终态消息不在本页的 step 保留全部增量。这涵盖仍在流式输出的 step、在产出消息前被打断的 step——`finalNode` 仅凭分块推导出的 blocks 构建其 `interrupted: true` 节点，那些增量是它唯一的记录——以及消息落在向上翻页上界之外的 step。

该投影是网关插件上一个经校验的 `Config` 字段 `historyElideSettledDeltas`，默认为 `true`；需要排查原始流的部署将其设为 `false`，即可收到全部已记录分块。持久化毫无变化：日志保留每一个分块，模型请求据此重建出的内容原封不动，因此**模型可见 ⟺ 已记录**依然成立。本次改动只影响一次读取向客户端下发的内容。

`paginate` 用二分查找在 seq 升序的日志上定位两个分页边界并返回单次 `slice`，`historyCutOf` 则把已附加 Session 缓存好的冻结 `events` 快照直接透传，而不再展开复制。三次整数组复制就此消失；同步取值约定不受影响，因为没有新增或移动任何 `await`。

## What ui-trajectory needed

审计将「`ui-trajectory` 的 Definition 是否需要已结算 step 的增量」标记为未验证。答案是需要，共两处，且上文都是保留而非破坏：`updateChunk` 是 `firstTokenTime` 的唯一写入者，该值以 `AssistantTiming` 抵达用户；它也是重试过的 step 所报告的累加 `usage` 的唯一写入者。`ui-trajectory` 从已结算 step 的分块折叠出的其余内容——`blocks`、`firstVisibleSeq`、`firstVisibleTime`、`sawChunk`——要么在 `assistant/message` 分支被 `toAssistantBlocks(message.content)` 替换，要么仅在该 step 尚无已结算节点时才被读取。

`session.history` 与 `subagent.history` 恰好只有一个生产消费者：Web 客户端的 `Session` 对象（`packages/client/runtime`）。没有任何宿主路径、SDK 或 ACP 面读取历史页。

## Testing

`packages/host/apiproxy/tests/api-proxy-history-deltas.spec.ts` 钉住这条边界：一个已结算 step 只下发它的首个 token 增量和 `usage` 分块，其另外七个已记录分块留在日志中；位于已结算 step 之上、仍在进行的 step 下发其全部四个增量；记录于某 step 消息之后的增量得以存活；不含 assistant 消息的页面原样下发；重建出的逐 step 终态内容与未略去的日志所得一致；向上翻页恰好以 `beforeSeq - 1` 结尾；五个各含 200 个增量的已结算 step 从 1,020 个分块收缩到十个，同时页面事件数缩减 20 倍以上、字节数缩减 4 倍以上；以及 `historyElideSettledDeltas: false` 下发全部已记录事件。

`packages/host/apiproxy/tests/session-export.spec.ts` 钉住该配置字段的默认值、退出开关，以及对非布尔值的拒绝。

`api-proxy-view.spec.ts` 中的分页回归测试现在在关闭该投影的情况下运行，从而继续断言它当初所针对的原始切分。

## Alternatives considered

**丢弃已结算 step 的全部分块。** 收益最大，却破坏两项对用户可见的事实：每个已结算 step 的首 token 计时变为 null；重试过的 step 在 Trajectory 中的用量会从累加总量悄然变成最后一次尝试的用量。每个 step 两个极小事件即可换来精确保真。

**在历史请求上增加 `include` 选择器，让浏览器索取无分块的页。** 为一个宿主本可自行正确作出的决定引入协议约定改动和客户端改动；它还允许客户端请求一个其进行中 step 没有内容的页面。哪些增量已被取代是宿主知道的，客户端不知道。

**只略去增量的载荷主体、保留事件本身。** 保住了 seq 的稠密性，也保住了实测中占主导的逐事件成本：8,779 个信封仍要解析、校验、匹配和折叠。它还会产出声明类型不再描述其内容的事件。

**通过第二次调用按需下发已结算的增量。** 没有消费者需要它们。为无人读取的数据新增一个取回面是有成本而无客户；配置开关已覆盖唯一真实的场景，即调试原始流的部署。

**对页面最后一个事件做特判，而不是比较位置。** 排序不变量已使该防御分支不可达，因而永远无法被测试。按位置判定取代关系直接表述该性质，并给出相同的保证。

**假定 `seq === index` 并按算术切片**（审计对 `paginate` 的建议）。对今天的 Session 日志成立，却会对任何不从 seq 0 开始的数组静默切错。二分查找在一条本已做 `n` 量级工作的路径上只花 `log n`，且无需这样的假定。

## Consequences

本机最大 Session 的 50 条消息尾页实测从 8,779 个事件 / 3,165,545 B 降到 455 个事件 / 880,455 B——事件数少 19.3 倍、字节数少 3.60 倍——通过真实的 `ConversationNodeAssembler` 加 `ChatSnapshotBuilder` 装配它的耗时从 63.4 / 38.2 / 44.2 ms 降到 2.8 / 2.8 / 2.3 ms。两个页面上每个已结算 assistant step 重建出的终态内容逐字节一致（36 个 step，87,538 B）。移除三次数组复制又从同步取值路径上拿掉了每次读取一份整日志的展开。

客户端不再能从历史中重放某个已结算 step 逐 token 的到达过程；它转而渲染已完成的消息，而这正是消息落地后它此前渲染的内容。任何需要原始流的场合去读日志，或以 `historyElideSettledDeltas: false` 运行。

略去是按页而非按 Session 决定的，因此跨页边界的 step 会在缺少其消息的那一页上保留增量。这个保守方向是对的：客户端持有的页面始终包含足以渲染其所显示内容的信息。

审计接下来测得的 `session.history` 成本——为下发 50 条消息而读取、解析并冻结整个日志——未被触及，仍主导着一次冷打开。

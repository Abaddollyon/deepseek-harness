# Agent Note: Session Model-Route Projection

Status: implemented

[English](2026-08-19-session-model-route-projection.md) | 中文

## 问题

一个会话实际运行在哪个提供方与模型上，这一事实此前只存在于 Host 端。`RequestContext` 本身是持久的——只要提供方、模型或公布的容量与上一个请求不同，agent（智能体）循环就会追加一条 `request/context`——但唯一的读取方是 Host 侧访问器 `Session.requestContext()`。没有任何通道把路由送到浏览器，因此列出会话的客户端最多只能显示组合出的 `agentPreset` 名称，而在不使用 preset 的部署里则什么都没有。混合模型的 swarm（多个子会话并行运行在不同路由上）逐行看去毫无区别。

容量本身已经通过 `contextPressure.contextWindow` 到达客户端，这说明传输链路是通的；与它并列的身份信息却没有一起走。

## 决策

`@deepseek-ai/dsh-token-meter` 注册第四个会话投影单元，键为 `modelRoute`，提供由 `request/context` 按后者胜折叠出的 `{ provider, model, contextWindow? }`。`request/context` 携带变更后的完整路由，因此这个 fold 只涉及一种事件类型和一次赋值：[`src/route-projection.ts`](../../../../packages/llm/token-meter/src/route-projection.ts)。该键、其载荷类型以及 `SessionProjectionMap` 合并都放在本包面向客户端安全的出口 [`src/projection.ts`](../../../../packages/llm/token-meter/src/projection.ts)，浏览器侧聚合可经既有的 `@deepseek-ai/dsh-token-meter/client` 命名空间取用。注册加入本包既有的可选 `ctx.inject(['sessionProjections'], …)` 子 fiber，因此卸载 meter 会与另外三个键一起移除它。

### 缺失用 `null` 表示，而不是缺键

注册表在每次快照中都会提供每个已注册单元，键无法有条件地缺席。因此 `modelRoute` 的类型是 `ModelRouteProjection | null`：在该会话首个请求记录路由之前为 `null`，从不发起请求的会话则终生为 `null`。之所以用值而非 undefined 字段作哨兵，是因为投影值要穿越 JSON 传输——undefined 字段会被丢弃，接收端就会留着一个陈旧路由——这也正是 `subagent` 身份投影使用 `null` 的理由。任何时候都不会臆造占位路由。

### 由构造方式保证与模型无关

fold 逐字复制已记录的 `provider` 与 `model`，且只对它们做相等比较。单元内不存在提供方清单、模型清单、别名表、系列启发式或兜底路由，因此该值报告的就是组合实际解析出的路由，新增适配器无需改动此处。`contextWindow` 当且仅当已记录路由公布了容量时才出现；后续没有容量的路由会丢弃该字段，而不是把上一个数字带下去。

### 为什么由 token-meter 拥有

在本仓库里，`request/context` 已经只有一个 fold 归属：token-meter 的 `contextPressure` 单元读取同一事件作为容量分母。把路由放在它旁边，可以让一个包解释一条持久记录，并让两个单元都会发布的 `contextWindow` 只在一处派生。token-meter 还已经在任何存在 `ctx.sessionProjections` 的地方被组合（base 与 web-app bundle 以及三个可运行示例），因此该键无需新增任何组合行、bundle 依赖或客户端注册面，就能覆盖每个拥有投影注册表的会话。

## 备选方案

**新建一个单投影包（`model-route`）。** 它更贴合 token-meter 自述的职责范围——测量而非身份——而且 session-stats 就是单投影包的先例。否决它的原因是：那会让第二个包去折叠 `request/context` 并独立发布 `contextWindow`，为了一个三字段的值把一条持久记录拆给两个所有者；而且该键只会存在于单独组合了那个包的地方。职责范围上的张力改用文字回答：README 现在写明测量服务自身不解析任何路由，`modelRoute` 只是把循环已记录的内容重新发布出来。

**给 `contextPressure` 加上 `provider` 与 `model`。** `contextPressure` 被明确记载为一组彼此独立、各自后者胜的记录，**不是**对单个请求的一次原子观测，而且其字段在提供方报告用量之前一直缺失。路由身份早一个事件就已知且精确，把它并入一个近似的占用率值会让它继承本不存在的不准确性，也会迫使只需要路由的消费方依赖「用量已被报告」这一前提。

**改用 Host RPC 提供路由，而不是投影。** 投影已经通过 `SessionSummary.projectionValues` 为列表中的每个会话提供数据，无需逐会话订阅，这恰好就是混合 swarm 的读取方式。专门的调用会给每一行增加一次请求，也无法从冷检查点回放。

**只在请求成功后才报告路由。** 循环在派发前就追加 `request/context`，因此以成功为门槛的值需要第二个事件和跨事件关联。这项读取是身份展示，不是计费或门控输入，所以更早、更简单的记录胜出；README 记录了「即使后续每个请求都在该路由上失败，它仍报告为当前路由」这一事实。

## 影响

- 任何读取 `SessionSummary.projectionValues.modelRoute` 的客户端都能拿到逐会话的提供方／模型身份，两端都不需要任何厂商知识；适配器不公布容量的部署只是省略 `contextWindow`。
- 会话多出一个投影键，因此每个会话的检查点行集合与每次快照都增加一个小 JSON 值，路由变更会多发一帧变更。
- token-meter 的包职责范围现在包含一个非测量事实。README 写明了这一划分，以免估算器与路由无关这一点被读成自相矛盾。
- 消费方必须把 `null` 当作「尚无路由」，而不是错误；该值绝不会只填一半。
- 对持久投影缓存早于该键的会话，首次冷恢复会从 seq 0 读取日志：缺少行的键会让 `restoreFloor` 把下界拉到零，而 `restore` 因该下界为零而直接从 `init` 重新折叠、不会抛错。之后的每次恢复都使用刷新后的行。

## 测试

[`tests/model-route-projection.spec.ts`](../../../../packages/llm/token-meter/tests/model-route-projection.spec.ts) 覆盖：任何请求之前为 null、只记录轮次但从不请求的会话、首条记录、省略容量、会话中途换路由时的后者胜、更新路由丢弃容量、每个不同路由发出一次变更且重复记录不发变更、按 `seq` 冷回放重现实时值（含 null 情形），以及 meter fiber 释放时移除该键。[`tests/loader-composition.spec.ts`](../../../../packages/llm/token-meter/tests/loader-composition.spec.ts) 通过 vendored Loader 启动已发布的 YAML 形态，断言组合后的注册表提供全部四个键、`modelRoute` 从 `null` 起步，并在变更流上发布每个解析出的路由。

## 相关

[Projected Token Usage and Request Context](../architecture/2026-07-29-projected-token-usage-and-request-context.zh.md) 拥有「`request/context` 作为容量记录」以及刻意非原子的占用率配对这两项决策；本文只是为同一事件增加身份读取方，并不改变那项决策。

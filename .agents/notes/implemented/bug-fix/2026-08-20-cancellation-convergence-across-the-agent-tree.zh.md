# Agent Note: Make a stop actually stop — cancellation convergence across the agent tree

Status: implemented

[English](2026-08-20-cancellation-convergence-across-the-agent-tree.md) | 中文

## 问题

三个独立缺陷让 Web GUI 的停止按钮不可靠,而且它们相互叠加:每一个都会隐藏、撤销或未能送达用户已经请求的取消。这三个缺陷都是通过追踪整条路径发现的——composer 点击、`session.cancel`、`Agent.cancel`、abort 信号、LLM `fetch`——这条路径本身在宿主上是干净且同步的。所有真实故障都发生在 abort 的下游。

**被拒绝的 initiator 边界让 agent 永久卡在 `running`。** `wakeDriver()` 在调用 `ctx.agents.withInitiator(this, () => this.kick())` 之前就发布了它的 driver 预留——`activityDone` 加上 `running` 阶段。一旦注册表停止接受边界,该调用会*同步*抛出(`AgentRegistry.runWithInitiator` 守卫 `initiatorState !== 'active'`,而 `internal/status` 会在某个生命周期祖先 fiber 卸载时将其翻转为 `'closing'`)。`.then` 从未挂上,因此 `driver.promise` 永不结算:阶段永远停留在 `running`,`cancel()` 中止的是一个无人等待的 controller,而 `whenIdle()`——连同每个 `AgentHandle.dispose()`——挂起。任何落在拆卸窗口内的 `followup()` 都能触达这一点,而结算通知或 `send_message` 恰恰落在那里。

**正在结算的子级重新打开了其用户刚刚停止的轮次。** `notifySettlement` 通过 `Agent.followup()` 投递,而对一个静止的 Agent 调用 `followup()` 会*打开一个轮次*。停止之后父级是静止的,因此之后每个结算的后台子级都会重启用户已结束的会话——每个子级一次,这就是症状随 subagent 数量放大、读起来像"停止按钮没有任何作用"的原因。

**停止到达了一个 Agent 却让它的子树继续运行。** `interrupt()` 只取消被指名的目标;对顶层会话的 `session.cancel` 只取消该会话的 Agent。可继续子级是独立的 Activation,由它们自己的结算观察者而非父级的轮次来 dispose,因此它们在停止之后继续消耗模型调用——然后触发上面的缺陷。

**循环无法表明自己正在停止。** 它仍会在中止的轮次结束之前排空已启动的工具调用(`executeToolCalls`),因为 `dsh-tools` 承诺取消永不抛弃已启动的 body。这是诚实的等待,不是丢失的停止——但 `AgentStatus` 只有 `idle | running`,因此从请求 agent 停止到其状态到达 `idle` 之间的时间段与普通工作无法区分,得不到任何反馈的用户会合理地断定控件坏了并再次点击。

**维护任务在 agent 报告 `idle` 期间运行了一整个模型请求。** `runMaintenance` 持有一个 `maintenance` 阶段,其 `status` getter 回答 `idle`,因为没有打开的轮次。手动压缩和计划任务都在那里运行。因此从 `running` 渲染其停止控件的宿主在整个压缩期间根本不提供任何控件,尽管 `Agent.cancel()` 已经会中止该任务的信号——能力存在,却无路可达。

## 决策

**在 initiator 边界内部发布 driver 预留。** `runWithInitiator` 在调用操作之前就抛出其守卫,因此把 `activityDone` 和 `setPhase` 移入回调后,一次拒绝就不会提交任何东西——没有回滚代码,也没有新分支。这是"只在提交点发布状态"规则的字面应用;try/catch 后回退的替代方案会先发布一个 `running` 状态再撤回它,向实时 `agent/status` 监听者发出一对多余的 `running → idle`。

**由发送方而不是循环决定通知是否唤醒。** `notifySettlement` 扩展其现有的 draining-parent 分支——该分支已经选择不唤醒的 `Agent.inject()`——使其同时覆盖最新持久 `turn/end` 为 `{ kind: 'aborted', reason: { kind: 'user' } }` 的静止父级。通知仍会持久落入 inbox,并由用户接下来打开的任意轮次认领;它只是不会自己打开轮次。

**给两种中断权限各自本来要表达的作用范围。** `ancestor` 中断是一个 agent 停止另一个 agent 的当前轮次,保持单目标——停止了 worker 的编排者并没有要求停止该 worker 的 worker,`interrupt_agent` 也是这样告诉模型的。`user` 中断是人结束一个会话,以 `parent` cause 取消目标的整个存活子树。`SubagentRuntime.cancelDescendants(parentSessionId)` 是宿主在其自身 `Agent.cancel()` 旁调用的顶层配套,因为普通会话没有 Activation,因而不拥有 `ownedChildren` 边。

**通过第二个 facet 而不是第三个 status 报告这两个不可见状态。** `AgentActivity` 是 `'stopping' | 'maintenance'`,或者当 `AgentStatus` 单独就足以描述 agent 时为 `undefined`;`Agent` 将其暴露为可读属性以供基线读取,并在其自有的 scoped `agent/activity` 事件上发布每次变化。`stopping` 由 `cancel()` 在任何非 idle 阶段设置,并在该阶段退役时清除;`maintenance` 在 `setPhase` 中由阶段本身推导。activity 在 status **之前**发布,因此没有监听者会观察到一个已 `idle` 却仍声称 `stopping` 的 agent。没有新增会话事件:这是实时传输状态,因此模型可见 ⟺ 已记录规则不受影响——停止的持久记录仍是带 `aborted` reason 的 `turn/end`。

**在 step 和 turn 边界回到事件循环。** 通过已解决的 promise 跨越的边界永远不会离开微任务队列,而 Node 会在到达 timers 或 I/O 之前把微任务队列完全排空。因此驱动多个进程内 agent 的宿主会整段时间不服务 socket:入站取消从未被读取,因此没有 abort 能被观察到,排队的流帧也不会被刷出。每个边界一次 `setImmediate` 跳转——其下一次迭代会经过 poll 阶段的 check 阶段跳转——把排空变成保证。它的成本是每个模型请求一个宏任务,因此它是无条件的,没有可调项。

## 备选方案

**在 `withInitiator` 外包一层 `catch` 中回退阶段。** 已否决:它会发布一个随后必须撤回的 `running` 状态,并添加一个实践中不可达、per-file 覆盖率门无法诚实满足的分支。在边界内部提交则两者都不需要。

**在 `wakeDriver` 中按取消 cause 抑制唤醒。** 已否决,且理由是承重的:`cancel.spec.ts` 刻意固定了落在 abort 到 idle 窗口内的**人类**重新提示的锁存([cancel-convergence wake latch](2026-08-07-cancel-convergence-wake-latch.md),其生产 `keepInbox` 消费者是 [web stop preserves queue](2026-07-31-web-stop-preserves-queue.md))。循环无法区分人类重新提示和运行时通知,它也不应学会区分——这种区分属于发送方。选择 `inject()` 还顺带绕过了锁存,因为 `inject` 就是 `send(..., 'next-step', wakeup: false)`,根本不会到达 `wakeDriver`。

**读取实时状态而不是日志来判断"用户停止了这个"。** 已否决:已收敛的取消留下的是一个普通的 `idle` 阶段,与完成无法区分。持久的 `turn/end` 是这次停止的唯一记录,这是模型可见 ⟺ 已记录规则的自我回报。

**对每种中断权限都级联。** 已否决:那会悄悄改变模型在提示中被告知的 `interrupt_agent` 契约,而停止单个 worker 的编排者没有理由杀掉该 worker 自己的委托。

**在级联中遍历 `ownedChildren`。** 仅就入口层否决:顶层会话没有 Activation,因而没有这个集合。从每个 Activation 记录的持久 `parentSession` 解析每一层可以用一个循环处理两种调用方,并且由于该关系是一棵树——每个 Activation 只记录一个父级——遍历无需 visited 集合簿记即可终止。

**第三个 `AgentStatus` 值 `'stopping'`。** 基于对每个读取方的证据否决。`goal-round-driver`、`schedule` 运行时和 `compaction-basic` 都在 `status === 'idle'` 上分支,因此第三个值会悄悄扣留它们据以行动的转换——被取消的 goal 永远不会暂停,schedule 永远不会驱动。`sdk/server` 将该值原样转发为其 `session.status` 通知,使这个枚举成为一个 wire 契约,其 SDK 期望输出必须随之改变。这些全都位于本次变更不拥有的包中。第二个 facet 是增量的:现有读取方收到的与之前完全一样。

**把 facet 作为 `agent/status` 的额外字段携带。** 已否决:activity 会在 status 不变时变化(idle→maintenance、running→stopping),因此事件必须在两者任一变化时触发——这些额外发射会以重复转换的形式到达同样的 `status === 'idle'` 消费者,并以重复通知的形式到达 SDK wire。agent 不变量的 no-op 转换检查也必须放宽为成对比较,为了携带一个无关事实而削弱一个真实保证。

**从工具调用调度器的 abort 锁存设置 `stopping`。** 已否决,既更窄又需要更多管道:`executeToolCalls` 是一个模块函数,需要一个写入 agent 私有阶段的写入器,而工具排空窗口只是该时间段的一部分。非 idle 阶段上的 `cancel()` 正是停止被请求的那一刻,它还覆盖 LLM 流拆卸和未写入的轮次结束——一行代码,写在已经拥有该转换的方法里。

**每个 LLM chunk 或每次工具调用结算时让出。** 已否决:每个 chunk 本就来自一次 socket 读取,循环已经处于 poll 阶段,在那里让出毫无收益;每工具让出会在每个 step 触发 N 次,却不能带来 step 边界之外的排空,还在有序提交窗口内增加挂起点。

## 影响

`wakeDriver` 现在把注册表的拒绝传播给其调用方而不触碰 agent:唤醒消息保持排队,阶段保持 `idle`,`whenIdle()` 和 handle dispose 都会结算。到达被用户停止的 idle 父级的结算通知被注入而不是唤醒,因此已停止的会话保持停止;未停止父级的行为不变,而正在运行用户在停止*之后*打开的轮次的父级,其最新结束记录仍是那次停止的结束,并保留普通引导——`status === 'idle'` 合取项由此而来。`user` 中断现在向每个存活后代发信号,因此恢复的子树从一个已停止的轮次恢复,而不是从一个在停止后继续运行的轮次恢复。

轮次边界让出位于 `phase.abort` 被替换为新 controller **之后**。这个位置是承重的:落在窗口内的取消必须中止下一轮次读取的那个 controller,而在交换之前被中止的 controller 会与旧的一起被丢弃。两个边界原本就已是异步挂起点,没有会话追加移动,每个取消落点窗口都保持 `cancel.spec.ts` 固定的样子。

`AgentActivity` 是增量的:`AgentStatus` 保留两个值,每个现有读取方保持其行为,而想要该限定符的消费者订阅 `agent/activity` 并从 `Agent.activity` 初始化自身。agent 不变量现在像拒绝重复 status 转换一样拒绝重复的 activity 转换,并把首次 `undefined` 视为真实转换——从未发布过的 facet 与刚被清除的 facet 不是同一个事实。两个生成的产物机械地跟随新事件,并由各自的命令重新生成而非手工编辑:`packages/core/scope/src/scoped-events.generated.ts` 获得其 subject 解析器(`pnpm run gen-scoped-events`),cordis API 目录获得事件和类型行(`pnpm run gen-cordis-api`,先在 `LINK_MAP` 中把 `AgentActivity` 分类到 `AgentStatus` 旁)。

宿主和客户端两半——在会话状态帧上转发该 facet、在客户端运行时镜像它、以及渲染禁用的 stopping 控件和维护期间的停止控件——不在本次变更中,属于各自的所有者。在它们落地之前,该 facet 已发布且可读,但没有任何东西渲染它。

顶层级联的宿主半边——`dsh-host-apiproxy` 中 `session.cancel` 的 `Agent.cancel` 旁的 `cancelDescendants` 调用——不在本次变更中,已为 apiproxy 所有者跟踪。在它落地之前,对普通会话的人发起停止仍会让其后台子级继续运行,不过不再让它们重启该会话。

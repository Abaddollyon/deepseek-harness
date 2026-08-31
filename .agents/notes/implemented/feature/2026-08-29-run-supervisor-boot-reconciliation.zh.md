# Agent Note: Run supervisor——持久任务记录的启动 reconcile

Status: implemented

[English](2026-08-29-run-supervisor-boot-reconciliation.md) | 中文

## 问题

持久任务注册表（J 切片）在启动时恢复记录后便止步：它不持有会话感知，也不持有策略。若放任不管，一条上一 incarnation 的可恢复记录在其生产方始终不注册 resumer 时会永远停留在 `running`——这是对早已随进程死去的工作的谎言——而启动恢复时诚实结算的记录则完全无法抵达模型：恢复出的结算不持有存活属主，`tool-jobs` 的完成监听器会跳过它们，也没有任何会话事件说明发生了什么。必须有一个 host 平面的角色来负责属主解析、恢复策略旋钮、面向模型的账目，以及孤儿保留。

## 决策

新增 Consumer 包 `@deepseek-ai/dsh-run-supervisor`，挂载在 host 组合的 `jobs-local` 与 `jobs-store-domain` 之后。它注入 `['jobs']`，并把 `jobStore`、`agents`、`sessionPersistence` 视为可选。当 store 服务激活时（其 inject fiber 在注册表更早注册的收养 fiber 之后触发），运行一趟有界流程：

1. 枚举 `incarnation` 不同于 `PROCESS_INCARNATION` 的 running 记录——同 incarnation 检查保证进程内重载不会把活工作诚实结算；持久的 `stopping` 记录是取消状态，绝不会重新进入恢复。注册表成员资格通过 `get()` 的围栏错误探测：`'unknown job'` 表示注册表从未恢复该记录（persist 未启用），记录一次日志并原样保留。
2. 按 `ownerSession` 分组并解析属主：存活 agent、可恢复会话（`sessionPersistence.prepare`，立即 dispose）、孤儿；若没有 persistence seam 则为*未知*——不会仅凭证据缺失就结算任何记录。
3. 应用策略：`resumeOnBoot: false` 全部结算；孤儿属主的记录以 `'owner-unavailable'` 结算；每属主最旧的前 `maxResumedRunsPerOwner` 条保持可收养，超出部分以配额详情结算；熬过 `bootResumeTimeoutMs` 的以 `'reconcile-timeout'` 结算。这趟流程总会完成，进程总会启动。
4. 通过注册表的 `registerResumer` 拒绝通道驱动结算——这是唯一能触及被恢复记录的、无围栏的公开通道。它保留 `reported`、维持 first-wins 终止语义，并把结算经 supervisor 自己的 `onJobDone` 监听器带回入账。由于该通道一次回放整个 kind，当 kind 仍有可收养记录待处理时，其结算目标会等到该 kind resolve或截止。
5. 为一切记账：生产方 resumer 返回延迟启动计划；注册表提交重新盖章的记录、等待每个 `onJobAdopted` 观察者，并且仅在没有观察者显式否决所有权时启动生产方。没有任何一趟流程观测到的收养——在 supervisor 挂载前就已触发的 resumer，或记账前就已消亡的进程——由持久的 `adoptedFromIncarnation` 标记作证，下一趟流程将其记为 `run/resumed`、以标记的 incarnation 命名，并且只有在 append 被确认已记录或发现已存在后才清除标记——任何通道都触及不到的属主会把标记留给之后的启动。supervisor 会保留已恢复记录，直到观察到其完成，包括在 supervisor 挂载前恢复且已终止的标记记录。`run/resumed` 与 `run/abandoned`（声明合并、log-only、绝不 `ignorable`）经存活 append 或以日志下一 seq 的持久离线 append 写入属主会话；已携带该 job 事件的日志不会被重复写入，因此反复重启不会重复账目。未被报告的终止记录欠其存活属主恰好一条注入式完成通知（`reported` 持久为 true 时一条也不发），随后 supervisor 经 `jobs.wait` 把记录认领为 reported——绝不用 `read`，那会消耗流式任务的输出游标。`run/detached` 在此声明以使 `run/*` 词汇有唯一的家，但它由后续的 workflow 切片发出。
6. 超过 `orphanRetentionMs` 后直接驱逐无属主终态记录；有属主终态记录仅在属主既无法存活命中也无法被 persistence 列出时驱逐——仅持久层驱逐；有属主的内存副本驻留并被围栏在已死会话里，对任何调用者不可见。

每个限额都是经验证的 Config 字段（`resumeOnBoot`、以 `MAX_TIMER_DELAY_MS` 为上界的 `bootResumeTimeoutMs`、`maxResumedRunsPerOwner`、`orphanRetentionMs`）；配置错误在加载时即响亮失败。

## 备选方案

**由注册表发出会话事件。** 否决：注册表刻意保持会话无感知、进程本地；面向模型的账目归 Consumer 所有，与 seam 文档的 Definition/Provider/Consumer 分层一致。

**把设计文档的精确详情字符串写到被结算的记录上。** 不可达：带围栏的公开接口不接受自定义 terminal 详情——`kill` 会标记 reported 并以 `killed` 结算，而拒绝通道硬编码注册表的诚实详情。因此记录携带 `'not resumable after host restart'`，精确原因写在 `run/abandoned` 事件与通知文本里——设计文档本就指定会话事件为面向模型的账目。已在 README 中如实记录，而非加垫片。

**由 supervisor 调用生产方 resumer 以执行配额。** 否决：恢复逻辑归生产方所有，它们直接向注册表注册，而注册表的回放以 kind 为粒度。因此配额只约束 supervisor 分类时仍待处理的记录；更早注册的生产方 resumer 会回放（并可能收养）其 kind 的全部待处理记录。已记为已知限制。

**用启动通知唤醒空闲的已恢复属主。** 否决：唤醒预算是 `tool-jobs` 私有的，不新增调节项就无法共享；通知一律注入并等待下一轮，且不做任何聚合——上级"不做通知聚合"的决定维持不变。

## 影响

宿主重启现在被完整记账：真正可恢复的 kind 经其生产方的 resumer 以原 id 继续，其余全部诚实结算并在会话日志里留下模型可重建的原因，未报告的完成恰好通知一次，孤儿记录随时间从持久 store 中老化清除。被恢复的 run 不会挂到恢复后 agent 的生命周期上（属主清理在 `start()` 时绑定），因此 dispose 属主不会取消它们——任务工具与注册表 teardown 仍能触及。workflow 切片将基于这些事件实现 `run/detached` 与 supervisor 所有的 workflow 交接，此处无需进一步改动。

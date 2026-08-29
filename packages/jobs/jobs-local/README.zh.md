# @deepseek-ai/dsh-jobs-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-jobs`](../jobs/README.zh.md) 注册表约定的进程本地实现：`LocalJobRegistry` 把每条记录保存在内存中，铸造 `<kind>-<uuid>` id（生产方提供稳定片段时则为 `<kind>-<idHint>`），为每个所有者桶编排从 1 开始的展示序号，并且只交出全新快照，从不交出实时状态。作为插件加载后即注册为 `ctx.jobs`。当 `persist: true` 且挂载了 [`ctx.jobStore`](../jobs-store-domain/README.zh.md) 时，记录还会镜像到持久存储；没有存储时其行为就是纯内存注册表。

## 准入

`maxConcurrentJobsPerOwner` 必须是正的安全整数，默认值为 `10`。调用生产方之前，`start()` 会通过按会话键控的所有者索引统计确切 owner 的 `running` 与 `stopping` 记录；所有无 owner 任务共享另一个独立的服务级桶。终止历史不占用容量，处于 `stopping` 的任务只有在生产方 `done` 结算后才释放名额。

达到容量时，`start()` 会在生产方执行和 id 分配前失败；错误会给出上限，并告诉模型使用 `job_kill`、等待任务完全停稳后再重试。注册表不会排队或抢占任务，也不会维护第二份可变计数。

## 生命周期

任务属于其所有者和后端，而不是生产方工具 fiber，因此重载生产方或控制器不会停止任务。某个所有者的第一个任务会把一个会被等待的 effect 附加到对应 `Agent` 对象的 scope 上。所有者的 dispose（资源释放）会取消该对象的任务，等待生产方完全停稳，并移除其快照；复用的 agent（智能体）id 或会话 id 无法重定向旧的清理操作。

服务 dispose 会关闭监听器、取消所有存活任务、在 `teardownGraceMs` 期限内等待其记录完成，并从仍存活的所有者 scope 中分离 effect。如果销毁期间的取消操作抛出异常，服务会强制将记录标为失败，并警告工作可能成为孤立工作，而不会死锁；一个始终不结算 `done` 的生产方在宽限期到期后也会以同样方式被强制标为失败（`producer did not release within teardownGraceMs; work may be orphaned`），因此关停总能完成。

结算遵循首次结算优先原则：最早出现的终止结果（生产方结算、作为 `failed` 隔离处理的 `done` 拒绝，或销毁时的强制失败）只记录一次，随后释放等待方，再只通知监听器一次；各监听器的故障会单独隔离。挂起的等待会在监听器运行前把任务标记为已报告，因此完成报告方不会重复发出通知；销毁时的取消出于同样的理由也会标记：面向正在被销毁的所有者的通知不会有人读到。完成是一次结算最后才宣布的事情，排在记录提交与可见集变更发布之后，因为报告方可能同步开启一个模型轮次，而该结算的其他所有观察者都必须已经看到已结算的记录。

控制器与监听器按注册方所在的 scope 分层，形状与 tools 注册表一致：一次注册归档到其注册上下文的 scope，一次读取则把全局层与所有者的 scope 链求并集。因此一个进程级注册表能逐所有者地回答逐所有者的问题——对自身组合未附加任何控制器的所有者，无论其他组合附加了多少，`start()` 都会拒绝并抛出 `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)`；一次结算也只会抵达其所有者所属组合注册的监听器。

## 持久化

当 `persist: true` 时，每个提交点——注册、kill、结算、销毁时的 stopping 转换，以及终止态 read/wait 对 `reported` 的翻转——都会以“发出即不管”的方式把记录镜像到 `ctx.jobStore`。写入被拒绝时会记录日志并把这一条记录降级为仅内存；注册表自身的状态始终是权威。最终输出在持久化前会按 `maxPersistedOutputBytes` 截取（保留尾部）；内存中的输出永不截取。

存储挂载时，注册表会恢复其中的记录：终止态记录原样恢复（持久化的 `reported` 标志让通知门控跨重启保持正确）；来自上一个进程 incarnation 的非终止记录，要么立即诚实结算（`resumeSpec` 为 null——`not resumable after host restart`），要么以可见、可 kill 的状态等待其 kind 的 `registerResumer` 处理器决定收养或拒绝。本 incarnation 写下的非终止记录保持原样，因为进程内的注册表重载绝不能把存活工作误认为孤儿。恢复的记录保留其会话围栏但没有存活 `Agent`，其变更通过全局观察者通道宣布。

已结算历史按所有者受 `maxSettledJobs` 约束：超出上限的已报告终止记录按 FIFO 逐出（内存与持久镜像一并删除），而未报告的终止记录始终幸存——逐出它会丢失模型从未读到的完成通知。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrentJobsPerOwner` | `10` | 每个确切所有者或共享无主桶的活跃（`running` + `stopping`）任务数 |
| `persist` | `false` | 镜像记录到已挂载的 `ctx.jobStore`；无存储挂载时记录仅存内存 |
| `maxSettledJobs` | `100` | 每所有者保留的已报告终止记录的 FIFO 上限；`0` 表示不保留 |
| `teardownGraceMs` | `10000` | `disposeAll` 等待生产方释放的时限，超时即强制失败其记录 |
| `maxPersistedOutputBytes` | `65536` | 记录持久化最终输出的字节上限（保留尾部） |

## 模型体验

通过生产方插件和 [`dsh-tool-jobs`](../tool-jobs/README.zh.md) 间接影响；它们会呈现 job id、输出、状态、取消和完成通知。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **即使开启持久化，执行仍是进程本地的**：重启后记录幸存，正在运行的生产方不会。跨重启的续跑只存在于注册了 resumer 的 kind；其余一律诚实结算。
- **`persist: true` 而没有挂载存储时是静默的**：注册表无法区分“存储稍后加载”与“从未配置存储”，因此记录会留在内存中直到存储出现；由组合负责提供 `ctx.jobStore`。
- **静默无效的取消会占用容量直到销毁**：如果 `cancel` 返回后始终未结算 `done`，注册表就无法将其与缓慢停止区分开；该任务会持续占用一个桶名额，直到服务销毁在宽限边界强制将其标为失败。

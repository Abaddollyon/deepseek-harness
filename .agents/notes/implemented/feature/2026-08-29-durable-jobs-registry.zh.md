# Agent Note: 持久后台任务注册表

Status: implemented

[English](2026-08-29-durable-jobs-registry.md) | 中文

## 问题

后台任务记录只存在于进程本地的 map 中，id 由进程内计数器铸造（`<kind>-N`）。宿主一旦重启，所有记录——包括模型从未读到的完成——都会被摧毁；持久化的 id 也不可信：新进程会把 `subagent-1` 重新铸造给别的工作。持久的运行监管（能续跑则续跑，否则诚实结算）需要跨重启稳定的 id、一条持久记录，以及一个让后续进程收养或关闭所见记录的 seam。

## 决定

横跨 `packages/jobs` 家族的三项协同变更。

**id 变为 `<kind>-<uuid>`**（生产方提供稳定片段时为 `<kind>-<idHint>`），持久记录的键因此绝不会被重新铸造给别的工作。36 字符 id 的模型侧成本由每所有者从 1 起的展示 `ordinal` 承担：它随每个快照携带并被 `job_list` 首列渲染；完整 id 依然在场，因为其他任务工具接受的就是它。这是发布前深思熟虑的破坏性变更：所有引用一并更新，不留兼容垫片。

**持久存储 seam `ctx.jobStore`**（`dsh-jobs-store-domain`），构建在 storage domain 形态之上：一张以 `JobId` 为键的 `records` 表，在持久边界经 zod 校验，域版本 1 只拒绝不迁移——介质版本不匹配时在 open 处大声失败，而不是静默丢弃可能描述着运行中工作的记录。记录恰好持久化必须跨重启存续的事实：所有者会话（访问围栏）、status/detail/有界输出、`reported`（通知门控——模型已收集的恢复完成不得重复宣布）、`resumeSpec`（启动收养）以及拥有它的 `incarnation`。incarnation 是模块加载时铸造一次的进程事实（`PROCESS_INCARNATION`），进程内的插件重载因此绝不会把存活工作误认为重启孤儿。写入在 `writeBatchMaxDelayMs` 内逐 id 合并（任务记录是单调的生命周期快照；逐 id 最后写入获胜是可靠的）。

**注册表负责镜像与恢复。**`dsh-jobs-local` 新增可选的 `persist`：注册、kill、结算、销毁转换与终止态 `reported` 翻转都以“发出即不管”的方式排到存储写链上；写入被拒绝时记录日志并把这一条记录降级为仅内存（与 recorder 降级相同的隔离形态）。收养存储时它会恢复记录——终止态原样恢复；上一 incarnation 的非终止记录诚实结算（`not resumable after host restart`），除非其 kind 的 `registerResumer` 处理器以原 id 收养。保留策略（`maxSettledJobs`）每所有者按 FIFO 只逐出已报告的终止记录——未报告的终止记录是模型从未读到的通知，始终幸存；`teardownGraceMs` 为 `disposeAll` 设界，始终不释放的生产方会被强制失败（`producer did not release within teardownGraceMs; work may be orphaned`）而不是卡死关停。按会话键控的 `byOwner` 索引取代了线性所有者扫描——保留历史本会让后者退化为 O(记录数)。

## 曾考虑的替代方案

**保留计数 id 并持久化计数器。** 否决：计数器是崩溃可能丢失的共享全局状态，两个进程共用一个介质还会竞态；uuid 无需协调，并让按原 id 收养成为可靠操作。

**让注册表强制依赖存储。** 否决：TUI 与一次性 profile 不需要持久化；`persist: false`（默认）使行为与纯内存注册表逐字节一致，由既有套件除 id 形状断言外原样通过来证明。

**启动时一律诚实结算（不设 resumer seam）。** 否决：可继续 subagent 今天就真正可续跑，未来还会有更多 kind；`registerResumer` 把收养或拒绝的决定交给该 kind 的生产方，同时默认落在诚实失败上。

**不论 `reported` 一律逐出最旧终止记录。** 否决：逐出未报告的完成会静默丢掉通知门控存在的唯一目的。

## 后果

重启持久性现在是组合选择：挂载 `jobs-store-domain`（由 `storage-domain` 路由到真实介质）并设置 `persist: true`。后续的 run-supervisor 切片可以在 `registerResumer`、持久化的 `reported` 标志与 `incarnation` 之上构建启动对账和所有者通知，无需再动注册表。模型可见的变化是 `job_list` 行形态（`#<ordinal> [<kind>] … (id: <id>)`）以及 ack 与通知中的 uuid id；曾断言 `bash-1` 式 id 的跨包测试套件改为从产出调用读取 id。执行仍是进程本地的：记录会幸存，运行中的生产方不会，只有配备 resumer 的 kind 才能跨重启延续。

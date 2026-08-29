# @deepseek-ai/dsh-jobs-store-domain

[English](README.md) | 中文

持久任务存储 seam（`ctx.jobStore`）及其基于 storage domain 数据形态的 Service Provider。抽象的 `JobStore` 定义具备“读到自己写入”的同步读取、整条记录替换的 `put` 与 `delete`；`DomainJobStore`（默认导出）在 `ctx.storageDomain` 上实现它，使用一张以 `JobId` 为键的 `records` 表。[`dsh-jobs-local`](../jobs-local/README.zh.md) 在其 `persist` 打开时以“发出即不管”的方式往这里写记录，并在启动时读回它们，以恢复、续跑或诚实结算那些比宿主进程活得更久的工作。

## 持久形态

`JOBS_DOMAIN_VERSION = 1` 会盖章到后端 unit 上并且只拒绝不迁移：介质盖着不同版本时在 open 处大声失败，绝不静默丢弃记录——被丢弃的记录等于对可能仍在运行的工作撒谎。每条存储记录都在持久边界经 zod 校验（`jobRecordSchema`）；校验失败的记录以 `invalid-record` 报出其表与键。记录携带必须跨重启存续的注册表快照事实——id、kind、label、`ownerSession`、status、detail、有界输出、时间戳、`reported`（通知门控）、`outputLimitBytes`、`resumeSpec`（启动收养）、拥有它的 `incarnation`——外加域版本之内的记录级 `schemaVersion: 1`。域全局记录上一次启动：`{ incarnation, bootedAt }`，open 时以 `PROCESS_INCARNATION`（模块加载时铸造一次的进程事实）盖章。

## 写合并

`put` 在 `writeBatchMaxDelayMs` 窗口内合并同一 id 的连续写入：最新值取代排队值，所有调用方共享那一次持久写入的结算。任务记录是单调的生命周期快照，因此逐 id 的“最后写入获胜”是正确的。读取（`get`/`list`）在落盘前就能看到排队值。`delete` 会丢弃该 id 的排队写入（并 resolve 其写入方——它们的记录是被有意移除，而非丢失），并报告是否存在已存储或排队的记录。关闭时会先冲刷每个排队写入再释放域；冲刷失败只拒绝其写入方的 promise。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `domainName` | `jobs` | 存储打开的域（及后端 unit）名 |
| `writeBatchMaxDelayMs` | `200` | 逐 id 写合并窗口（毫秒） |

由哪个后端介质承载该域是 `storage-domain` 插件的路由决定（`backend`/`routes`），不属于本包。

## 模型体验

通过把记录镜像到这里的注册表和 [`dsh-tool-jobs`](../tool-jobs/README.zh.md) 间接影响；后者渲染注册表恢复出的内容——包括让“已收集过的恢复完成”不再产生重复通知的持久化 `reported` 标志。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **存储是镜像而非权威**：进程存活期间内存注册表始终权威；写入被拒绝只会把该记录降级为仅内存，不会让任务失败。
- **写合并用有界的持久化窗口换取写入量**：在 `writeBatchMaxDelayMs` 内硬崩溃可能丢失最新一次转换（绝不会丢失此前已落盘的整条记录）。
- **没有跨进程锁**：同一介质同一时间只属于一个进程；多宿主并发使用同一介质不在范围内。

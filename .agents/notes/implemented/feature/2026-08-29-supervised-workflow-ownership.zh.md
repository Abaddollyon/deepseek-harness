# Agent Note：受监督的工作流所有权

状态：已实现

[English](2026-08-29-supervised-workflow-ownership.md) | 中文

## 问题

此前，workflow 工具会一直拥有运行，直到调用它的工具步骤结算。这对前台使用是正确的，但 Code Mode 会在程序返回时中止嵌套工具 signal，因此工作流无法存活得比该步骤更久。若只是分离而没有新边界，又会产生无界 worker；进程重启还会让持久工作流卡片一直处于运行中。

## 决策

`dsh-tool-workflow` 增加 `ownership: caller | supervisor`，默认值为 `caller`。调用方所有权保留现有请求 signal、中止桥接、返回形态、错误、dispose 顺序和面向模型的描述。监督器所有权不传入调用方 signal，而是预分配 run id，并以稳定的 `workflow-${runId}` 作业 id、持久所有者 Session 身份和空恢复规格调用 `jobs.startDurable`。工作流生产方仅在初始作业记录提交后启动；工具随后追加 `run/detached` 并返回 `{ runId, jobId, status: "running" }`。作业取消钩子调用 `WorkflowRun.cancel`；最终输出 promise 会先等待结果与 dispose，再关闭记录器，并通过 `job_output` 暴露现有的有界完成渲染。

受监督工作流刻意不可恢复。启动协调会为每个未配对成员合成 outcome 为 `cancelled` 的 `tool-workflow/agent-end`，随后写 stop reason 为 `cancelled` 的 `tool-workflow/run-end`，最后写 `run/abandoned`。这一顺序维持工作流 invariant，并在面向模型的放弃说明之前让持久卡片离开运行状态。

WorkflowEngine Definition 暴露提供方已解析的 `maxRunWallMs`。当该值为零或组合中缺少 Jobs 时，监督器所有权会在插件加载时失败。这样既不复制 worker-thread Config，也不允许无界移交。`JobKindMap` 通过公开的声明合并子路径增加 `workflow`；workflow 不注册 resumer。

本说明部分取代[聊天中的持久工作流运行](2026-08-10-durable-workflow-runs-in-chat.zh.md)关于执行所有权的结论。旧说明仍负责记录与渲染；本说明负责可选的运行时移交。

## 验证

聚焦测试固定了不变的 caller 路径、加载时拓扑失败、即时 supervisor 结果与 detached 事件、不可恢复作业元数据、dispose 后的最终输出结算，以及 `job_kill` 到运行取消的路径。现有 worker-thread 取消测试固定共享子级 AbortController、父级取消分类、宽限计时器、强制终止和悬空成员合成。run-supervisor 测试固定离线 closer 顺序和无 detached 记录时的回退。所有变更的可执行文件均达到逐文件 100% 覆盖率。

## 考虑过的替代方案

**在工具 Config 中复制 `maxRunWallMs`。** 拒绝，因为两个配置上限可能不一致；引擎是执行权威，现在会发布其已解析值。

**注册一个通过重新运行脚本和参数来恢复的 workflow resumer。** 拒绝，因为子级可能已经产生副作用。重新执行不是继续，通常也不具备幂等性。

**使用一个包含可选前台／后台字段的输出 schema。** 拒绝，因为这会改变 caller 可见语义。工具会根据已配置的所有权构建精确 schema。

## 后果

部署可以在前台共享命运与所有者作用域后台作业之间选择，而无需改变脚本语法。受监督工作流能越过调用步骤，但不能越过宿主重启；重启会被如实记录，并关闭持久 UI 状态。作业输出仍然有界，显式终止不会产生重复完成唤醒，所有者 dispose 仍通过 Jobs 注册表回收运行。

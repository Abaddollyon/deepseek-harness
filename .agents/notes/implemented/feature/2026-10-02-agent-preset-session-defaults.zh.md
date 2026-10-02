# Agent Note: Agent preset 声明 Session 的初始默认值

Status: implemented

[English](2026-10-02-agent-preset-session-defaults.md) | 中文

## 问题

preset 决定 Session 拥有哪些工具，但模型路由与权限预设只来自 Host 默认值。因此，面向低成本对话或自我修改的 preset 会从用户上次在别处使用的模型与权限开始，每个 Session 都要在首轮之前手动执行 `/model` 并更改权限。

## 决策

[`dsh-agent-preset`](../../../../packages/preset/agent-preset/README.zh.md) 行可以声明可选的 `defaults` 块，其中包含 `model` 路由与 `permission` 预设名。registry 通过 `resolve()` 与名册返回它。[Session Controller](../../../../packages/api/session-controller/README.zh.md) 是唯一的消费者。`session.create` 创建新 Session 后，它沿用 `/model` 的校验路径，把默认模型记录为 `model/selection` 事件，并通过 `ctx.permissionPresets.set` 切换权限。空白 Session 更换 preset 时，仍等于被替换 preset 默认值或 Host 默认值的每个值改为新的默认值。不同的值视为显式选择并保留。不可用的默认值会记录警告，并保留 Host 默认值。

事件类型、header 字段与 Session 格式均不变。恢复、采用与 fork 的 Session 保留其已记录的值。subagent 与 workflow 子 Agent 在 Session Controller 之外创建，继续继承父级的路由、权限与 preset 修订。

## 备选方案

**每次请求时读取 preset 默认值。** 空白 Session 会在客户端显示 Host 模型，实际却运行另一个模型；配置编辑也会改变尚未开始的 Session。通过现有事件记录选择，使客户端视图与日志保持一致。

**按 preset 强制权限。** 固定一个用户无法更改的权限预设属于安全策略，而 preset 明确不是安全策略。默认值保留了用户的选择权。

**默认值无效时让 Session 创建失败。** provider 目录会在运行时变化，例如 pool 发现移除了某个模型。回退使 Session 始终可以创建，并在 Host 日志中留下警告。

## 影响

preset 无需客户端改动即可让其 Session 以自己的模型与权限开始。恰好等于被替换默认值的用户选择无法与默认值区分，会随 preset 切换而变化。webhook Session 在规则结果中指定权限预设与模型，不读取 preset 默认值。Session Controller 的定向测试覆盖创建、回退、空白 Session 切换、显式选择以及采用已有 Session。

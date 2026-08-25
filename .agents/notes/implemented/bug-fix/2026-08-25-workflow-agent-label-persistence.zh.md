# Agent Note: 工作流 agent() 标签抵达子 Session

Status: implemented

[English](2026-08-25-workflow-agent-label-persistence.md) | 中文

## 问题

`agent(prompt, { label })` 一直接受显示标签，持久运行面板也会在成员行上显示它。但标签从未跨越 worker→宿主线程边界：`ChildStartRequest` 没有 label 字段，worker 运行时为观察器叙述计算出标签后却没有把它放进 `child-start` 载荷，宿主的 `subagents.start` 调用也不传标签——尽管 `SubagentStartRequest.label` 本就可以把标签持久化进子级的持久 descriptor。于是工作流子 Session 在侧栏中只能显示裸 Session id，而旁边的运行面板却显示成员的真实名称。

## 决策

标签现在沿 [按 agent 配置推理等级](../feature/2026-08-19-workflow-per-agent-reasoning-effort.zh.md) 为每次调用选项建立的路径传递：`ChildStartRequest` 增加可选 `label`（`child-start` 协议载荷原样携带该类型），由 worker 运行时转发，再由宿主传入 `subagents.start`，由其持久化到子级的 descriptor。侧栏本就消费该 descriptor——subagent 的 list-children projection 会折叠它，客户端 Session 列表 projection 以 `child.label ?? childId` 显示——因此客户端无需改动。

只有脚本显式给出的 `label` 选项会被传递。未给标签的调用中，运行时为观察器叙述计算的提示词派生标签仍只存在于本次运行：未命名的 `agent()` 调用产生与此前完全相同的持久 descriptor，其侧栏行保留 Session id 回退。该线上字段端到端可选，因此从不发送它的对端也照常兼容。

## 曾考虑的替代方案

- **未命名调用也转发派生标签。** 拒绝：它会在没有任何明确意图的情况下改写每个未命名子级的持久 descriptor 与侧栏标题；本次弥合的缺口是显式标签丢失，而不是运行面板与侧栏原本就共享的那个有文档记录的回退。
- **让标签留在运行内部，由父级运行记录推导侧栏标题。** 拒绝：它会让 Session 列表 projection 跨包边界耦合工作流内部结构，而 subagent seam 本就拥有这条现成的通道。

## 后果

命名的工作流子级在运行面板与 Session 侧栏中名称一致，刷新后依然如此，因为标签存在子级自己的持久 descriptor 中，而不是存在任一 projection 里。忽略启动请求标签的进程外后端，对这里与对工具委派子级一样原样忽略；该字段是数据，不是能力开关。

worker-thread 测试在进程内协议上钉住两个方向——显式标签被转发、未命名调用不发送——真实 worker 的宿主测试断言标签落在提供方可见的启动请求上，而未命名的同类调用保持无标签。

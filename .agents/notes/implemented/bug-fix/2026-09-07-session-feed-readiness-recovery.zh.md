# Agent Note: 恢复 Session 数据就绪状态并保留导航

Status: implemented

[English](2026-09-07-session-feed-readiness-recovery.md) | 中文

## 问题

Host 可在 Session controller 所注入的服务可用之前开放 Remote gateway。此时首次 control 请求会以 `gateway/service-unavailable` 终止。已连接的传输层与 Client 中的空数组无法证明账户中没有已保存的 Session。首次权威列表到达之前，尚未完成的列表通知还可能掩盖已恢复的选择。

## 决策

[Session Client](../../../../packages/api/session-controller/README.zh.md) 负责 control stream 和列表就绪状态的有界恢复。它只重试 Gateway 已有的带类型服务不可用响应。接受 control baseline 后会拉取权威列表；二者均成功后，可观察的数据源才报告就绪。终止性失败保持可观察，手动重试会启动新一轮配置好的预算。失败期间数据源保留 Session 对象和选择；首次列表尚未到达时，不更改持久化选择。

每次替换都会阻止旧回调生效，并等待旧 control iterator 关闭。dispose（资源释放）取消重试计时器，阻止后续回调或显式重试重新打开数据源。载体断开仍使用 Gateway 已有的物理代次恢复机制；替换 baseline 和列表均成功之前，过期数据保持可见。

## 考虑过的替代方案

**失败后重新加载。** 重新加载可以恢复数据，但会丢失用户的本地交互上下文，并要求用户自行识别错误显示为空的界面。

**重试所有 Remote 失败。** 身份验证失败、业务拒绝和无效协议需要处理；重复请求会掩盖失败，且没有就绪信号作为依据。

**将连接状态视为就绪状态。** 可访问的 gateway 与受依赖约束的 Session 服务具有不同的所有者和完成时点，因此一个连接标志无法表达二者。

## 后果

就绪重试使用部署配置的有限延迟计划，并具有可见的终止状态。消费方区分加载中、过期、失败和成功读取后为空的视图时，必须将数据源就绪状态与保留的行结合使用。Loader 组合测试和针对性生命周期测试覆盖服务延迟可用、列表顺序、重试耗尽、手动重试、协议失败、载体恢复、选择保留和 dispose。

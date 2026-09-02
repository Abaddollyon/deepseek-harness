# Agent Note: Journal carrier 恢复归属于代次

Status: implemented

[English](2026-08-30-journal-carrier-recovery.md) | 中文

## 问题

journal follow 可能在产出 opening cursor 前丢失 carrier。journal 必须恢复这类传输故障，同时不能发布不完整窗口、重复已接受的 frame，或把健康的 live transport 误判为领域故障。

## 决策

carrier 恢复由 RemoteStream 负责。RemoteStreamCarrierError 在 Connection generation 可用时立即替换一次；替换的 follow 提供原子 snapshot 与 tail。RemoteJournalStream 只发布已接受的 opening snapshot，其 cursor 和协议校验保持不变。RemoteStreamError、畸形 frame、cursor 违规及其他领域故障仍是终止性错误：opening 被接受前，它们以原始错误对象身份拒绝 open()；opening 被接受后，它们确定性地传给 failed。

## 备选方案

**在 RemoteJournalStream 中重试终止性 journal 故障。** 拒绝，因为业务和协议错误归领域所有，重试可能重复已接受的 frame 或隐藏永久故障。

**在 opening 前的传输故障后重新读取 page。** 拒绝，因为 session.follow 原子拥有 snapshot 和 tail，page 不能替代这个 opening 约定。

**增加第二个 journal 生命周期控制器。** 拒绝，因为代次替换、取消和 dispose 已共享 RemoteStream 生命周期控制器。

## 后果

- opening cursor 前的 carrier 故障会恢复，不触发 journal failure callback，也不重复发布。
- 健康替换 opening 是恢复代次唯一发布的窗口。
- 现有有上限的 carrier retry 和 Connection backoff 仍是唯一恢复时序控制。
- opening 前的领域和 cursor 故障以原始对象身份拒绝 open()；opening 后的故障传给 journal failure callback。

## 验证

Client journal suite 覆盖 opening cursor 前发生 carrier 故障、随后立即出现健康代次的场景，并断言两次 follow、一次 replacement 发布和没有 failure callback。既有覆盖继续保证 opening 前终止性故障以原始对象身份拒绝 open()、opening 接受后触发 failure callback，以及替换、burst 和 dispose 行为。

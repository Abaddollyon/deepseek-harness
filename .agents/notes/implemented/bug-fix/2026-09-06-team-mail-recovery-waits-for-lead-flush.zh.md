# Agent Note: Team 邮件恢复等待 Lead flush

Status: implemented

[English](2026-09-06-team-mail-recovery-waits-for-lead-flush.md) | 中文

## 问题

Agent Teams 的 mailbox（[feature note](../feature/2026-08-05-agent-teams.zh.md)）会先向 Lead Session 追加 `team/message/queued` 并 flush，然后再尝试投递。Team 成员 Session 启动时运行的恢复过程在 Lead 事务之外读取实时 Team projection。`Session.append` 在 flush 完成之前就把事件发布到该 projection，而 flush 被拒绝的 Lead 事务仍会把其行留在 projection 中，因此恢复可能观察到 Lead 日志尚未持有的记录。

由此产生两个后果。第一，当发送方的 queued flush 仍在进行时运行的恢复会认领该记录并投递；发送方只在 flush 之后才注册自己的投递，发现记录已在进行中，于是对一条实际上已被投递一次的消息报告 `queued`。持久化测试 `reconciles a persisted child to active and a missing child to durable failed` 只要其 wakeup 发送落在对账事务的 flush 窗口内就会进入该窗口，而 CI 的 I/O 争用使之很容易发生。第二，持久化 flush 失败的记录仍可被下一次恢复投递，其背后却没有持久的 Lead 记录。

## 决策

**恢复在 flush 之后、于 Lead 事务内部快照并认领待投递邮件。** 当成员启动存在候选的 queued-minus-delivered 记录时，`TeamMailbox.recoverFor` 在 `journal.transact` 下运行 `sessions.flush(root.session)`，重新检查 Lead 仍是注册表中的确切实时条目，捕获候选记录，并在事务释放前注册每个投递。投递只在释放之后等待，因为投递会通过同一 journal 做 checkpoint。整个恢复与其他投递事务一同被跟踪，因此运行时 dispose 会等待它。没有候选记录的启动在任何事务或 flush 之前就返回。flush 被拒绝会使该次恢复被拒绝，恢复调度器以警告报告，且不投递任何内容；持久化的 write-behind 会保留被拒绝的批次并在下一次 flush 重试，之后的恢复再投递该记录。

**进行中集合仍是集合。** 发送方排入一个全新的记录 id，并在其生产事务内部、在任何恢复能捕获该记录之前注册自己的投递，因此没有任何公开的发送路径会发现自己的记录已在进行中；只有恢复可能被集合拒绝，且其被拒绝的结果会被丢弃。因此 `accepted`/`queued` 回执保持其既有含义：发送方自己的即时观察。

**内存语义。** `sessions.flush()` 报告是否有持久性监听器参与；mailbox 不把 `false` 解释为确认，也不要求后端存在。没有持久化后端时，恢复与其他 Team flush 保持同一份内存契约。

目标本地的 FIFO 准入、Lead 事务顺序、dispose 顺序以及目标 Session 去重保持不变。

## 考虑过的替代方案

**在测试中等待恢复完成后再发送。** 拒绝：恢复是没有完成信号的 fire-and-forget 过程，测试将依赖调度顺序，而底层"先投递后持久"的顺序问题依然存在。

**在事务内读取 projection 但不 flush。** 拒绝：journal 的事务尾部有意吞掉失败的操作，且 projection 已经持有被拒绝的 `appendAndFlush` 的行，因此仅靠串行化无法证明记录已持久。

**用 poison 集合跟踪失败的行。** 拒绝：write-behind 已经保留并重试被拒绝的批次，下一次成功的 flush 就是持久性证明；另设映射会重复该状态。

## 影响

恢复现在对每次存在候选邮件的成员启动付出一次 Lead flush；持久性持续失败的 Lead 在某次 flush 成功之前不会投递任何恢复邮件，这些邮件保持为可见的待投递状态。因 flush 失败而使 `sendMessage()` 被拒绝的发送方得到的是未知结果：记录留在实时 projection 中保持待投递，一旦保留的写入成功，之后的恢复就会投递它，因此被拒绝的发送并不保证不投递。一个成员的恢复投递现在在一个同步区间内进入各自的目标队列，而不是逐个进行；每个目标的队列顺序保持不变。

## 测试

`persistence.spec.ts` 通过 `session/flush` 监听器扣住 Lead 的 flush 确认：把 wakeup 发送落在对账 flush 窗口内，证明 queued 记录未确认期间没有 child 启动也没有投递，然后释放屏障并检查 `accepted` 回执、恰好一次目标投递以及恰好一条持久的 `team/message/delivered` 记录。其余用例让 Lead flush 在恢复期间和发送期间被拒绝，通过 logger exporter 观察恢复警告，证明记录保持待投递且没有投递，并展示 flush 恢复后之后的恢复恰好投递一次；在运行时 dispose 期间和 Lead 句柄 dispose 期间扣住恢复 flush，证明 dispose 会等待该次恢复且过期的 Lead 不认领任何内容；并统计没有候选邮件的启动的 Lead flush 次数。每个触及闸门的用例在之前的 mailbox 上都会失败。

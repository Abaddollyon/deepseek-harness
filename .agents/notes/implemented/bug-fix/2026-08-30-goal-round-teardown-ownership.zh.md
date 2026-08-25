# Agent Note：目标轮次 teardown 的提示词所有权

状态：已实现

[English](2026-08-30-goal-round-teardown-ownership.md) | 中文

## 问题

目标轮次驱动器可能在其自动提示词已被领取并阻塞于 agent pre-step waterfall 时卸载。Agent-loop 取消会保留待处理 inbox 输入，但恢复驱动器自身的已领取提示词会重新执行已经撤销权限的尝试。

## 决策

被中止的目标 pre-step 返回前，驱动器会从共享的已领取批次中移除确切的自身提示词。这样 Agent-loop 取消只会恢复其他已领取消息，外部人工输入仍保持待处理状态并由下一次生命周期继续。

## Alternatives considered

**保留已领取提示词供 agent-loop 恢复。** 拒绝，因为目标驱动器已经停用该尝试；恢复会在没有激活目标权限时重新执行自动工作。

## 验证

`packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts` 会阻塞目标 pre-step，加入外部人工输入，卸载驱动器，并断言只有人工消息保留。目标提示词不会被重新执行。

## 结果

目标 teardown 与 agent-loop inbox 恢复保持幂等：驱动器负责移除自身尝试，agent-loop 负责保留无关的已领取输入。

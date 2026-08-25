# Agent Note: 跨中止与生命周期拆卸的 inbox 持久性

Status: implemented

[English](2026-08-25-inbox-durability.md) | 中文

## Problem

agent 循环在系统提示词组装与 `agent/pre-step` waterfall 运行之前，就通过持久的纯删除 inbox splice 认领其步骤批次。当轮次信号在该窗口内任何位置中止时，已认领的消息已离开所有待处理列表，且任何模型请求都未曾见过它们：它们随被中止的轮次一同消失。两条生命周期路径加剧了这种丢失——agent-loop 的拆卸事务以默认选项执行 cancel，goal-round-driver 的拆卸以 `{ kind: 'parent' }` 执行 cancel，两者都会清空待处理 inbox 并记录 canceled splice，因此排队用户输入恰在会话即将于日后恢复的时刻被丢弃。

## Decision

在认领之后、步骤开始之前引发的中止，现在会在 `ReactLoopAgent.preStep` 内把未开始的已认领批次放回 inbox。恢复时把每条消息 prepend 回它被认领的列表——next-step 输入排在更新的 steering 之前，一条排队提示词排在更新的 follow-up 之前——并跳过任何已处于待处理状态的消息，因此自行重新入队或恢复了该批次的监听器绝不会产生重复。非中止的 pre-step 失败仍保持终止且批次保持已移除：拒绝的监听器已经恢复了它们要保留的部分，而静默重新入队会重放一个已被拒绝的提案。

两条生命周期拆卸路径都传入 `{ keepInbox: true }`：agent-loop 拆卸事务（`{ kind: 'disposed' }`）与 goal-round-driver 拆卸（`{ kind: 'parent' }`）。待处理 inbox 工作是会由每个恢复的生命周期重放的持久会话状态，而不是运行时残渣；拆卸会中断活跃轮次，但不再丢弃它从未认领的输入。[显式取消决策](../architecture/2026-07-16-explicit-turn-cancellation.zh.md)拥有取消词汇，[取消收敛唤醒闩锁](2026-08-07-cancel-convergence-wake-latch.zh.md)拥有唤醒输入如何与中止竞争；本 note 拥有什么能在它们之后幸存。

## Alternatives considered

**仅在 cancel 传入 `keepInbox` 时恢复。** 已否决，因为中止信号只携带类型化的原因，而显式用户取消仍会持续丢弃任何请求都未见过的已认领消息——这正是本变更关闭的丢失窗口。

**把持久认领推迟到组装与监听器成功之后。** 已否决，因为 `agent/pre-step` 载荷必须携带排他认领的批次，而在 waterfall 期间保持消息待处理会让第二个认领方观察到它们，破坏 claimed 通知所发布的排他所有权转移。

**让每个监听器继续恢复自己的消息。** 已否决，因为只有循环能看到每条已认领消息；选择性地恢复的监听器（goal-round-driver 会排除自己的预约）无法阻止其余消息消失。

## Verification

`packages/core/agent-loop/tests/inbox-durability.spec.ts` 固定了以下行为：pre-step 期间的中止恢复已认领的唤醒消息与已认领的 steering（各自在下一次唤醒时重新运行）；监听器先行重新入队时不产生重复；以及待处理 inbox 在 JSONL 持久化上经拆卸后幸存到恢复的生命周期。goal-round-driver 套件固定了排队的人工输入在驱动器拆卸后幸存，subagent continuation 套件固定了拆卸结算通知在父 agent 被处置后以待处理输入的形式幸存。

## Consequences

轮次在首个步骤运行前中止的提示词不再丢失：它会被后续轮次或重新挂载的生命周期再次认领。拆卸与 goal 驱动器拆卸让待处理 inbox 完整保留在持久日志中，因此恢复会从会话停止处继续，而不是从被静默截短的队列开始。真正有意丢弃待处理工作的调用方仍然可以：不带 `keepInbox` 的显式 `cancel()` 会清空待处理输入，只有未开始的已认领批次会被放回。

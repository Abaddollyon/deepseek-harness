# Agent Note: agent 拆卸时受等待的会话 flush

Status: implemented

[English](2026-08-25-teardown-session-flush.md) | 中文

## Problem

持久化协调器是延后写入的：`session/event` 追加会开启一个有界批处理窗口，只有 `session/flush` 屏障或后端拆卸才会立即排空。session-checkpoint-policy 在模型、工具分发和下一步骤边界之前 flush，但没有任何机制覆盖紧随 agent 拆卸的最终追加——已结算的工具结果、收尾的 `step/end`/`turn/end`。协调器确实会在 `session/disposed` 时排空被处置会话的 controller，但那次退役是仅观测的：没有任何一方等待它，因此已完成的 `dispose()` 从来不是持久性屏障，在拆卸边缘退出的进程可能丢失驱动器的收尾记录。

## Decision

agent-loop 的拆卸事务现在在驱动器达到停稳之后、agent 作用域撤销之前，于发出 `session/disposed` 的会话 detach 之前，等待 `ctx.sessions.flush(agent.session)`。因此，已完成的 `dispose()` 意味着每个已结束轮次的收尾事件都已送达持久化监听器。该 flush 是尽力而为的：监听器失败只记录警告，拆卸继续进行，因为拆卸是生命周期义务，绝不能因存储故障而中断——协调器自身不受等待的退役排空仍然是兜底。

## Alternatives considered

**改为等待协调器的退役。** 已否决，因为退役是持久化插件拥有的通知侧效应；让 store 的处置路径等待它，会把生命周期拥有方耦合到某个监听器的簿记上，并且仍然把非协调器的持久化监听器（泛指 `session/flush` 订阅方）留在屏障之外。

**在 `whenIdle()` 之前 flush。** 已否决，因为驱动器的收尾记录——最终的 tool/result 与轮次的终止边界——是在中止到空闲的收敛期间提交的；只有停稳之后的 flush 才能观察到它们。

**传播 flush 失败。** 已否决，因为拆卸运行在每条卸载路径上，包括错误恢复；存储故障绝不能让 agent 滞留在注册表中或破坏组合 fiber 的处置，而且失败仍会通过 logger 暴露。

## Verification

`packages/core/agent-loop/tests/teardown-flush.spec.ts` 固定了两半行为：拆卸会分发一次已经观察到已结算 `tool/result` 的 flush，并且在该 flush 解决之前不会完成；随后重新挂载的持久化后端能读回工具结果与收尾轮次边界；而拒绝的 flush 监听器会降级为一条日志警告，拆卸仍然完成并注销 agent。

## Consequences

句柄处置、调用方 fiber 卸载与提供方卸载都收敛到同一个备忘拆卸，因此每条 agent 退出路径现在都带有相同的持久性屏障。处置 agent 后立即退出的部署——自动化运行、 scoped subagent 宿主——不再可能丢失它们所拥有的轮次的最终已结算记录。

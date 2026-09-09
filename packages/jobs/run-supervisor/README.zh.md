---
description: "供维护者配置恢复策略、持久账目、模型通知与孤儿保留的持久任务启动 reconcile 消费方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-supervisor

[English](README.md) | 中文

## 概述

使用 `dsh-run-supervisor` 在宿主重启后协调持久任务。它解析每个任务的属主会话、应用有界收养策略，并持久记录已恢复或已放弃的工作。完成通知和任务工具结果向模型提供结果；记账事件仍仅留在日志中。

当组合持久化后台任务时选择它。将其挂载在 `jobs-local` 与 `jobs-store-domain` 之后；可恢复工作的处理器由生产方插件提供。

## 目录

- [启动 reconcile](#boot-reconciliation)
- [持久账目与模型通知](#model-visible-account)
- [孤儿保留](#orphan-retention)
- [配置](#config)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="boot-reconciliation"></a>
## 启动 reconcile

[`dsh-jobs-local`](../jobs-local/README.zh.md) 从 [`ctx.jobStore`](../jobs-store-domain/README.zh.md) 恢复记录：终态记录保持终态，上一 incarnation 的不可恢复工作被结算，可恢复工作等待生产方的 `registerResumer` 处理器。每次 store 激活时，在注册表更早注册的收养 fiber 之后执行一趟 reconcile，全程受 `bootResumeTimeoutMs` 约束。注册表从未恢复的记录（`persist: false` 或组合行顺序错误）只记录一次日志并原样保留。流程如下：

1. 枚举 store 中 `incarnation` 不同于 `PROCESS_INCARNATION` 的 running 记录，以及从 stopping 终态化为 killed 的恢复工作流记录。同 incarnation 的记录是进程内的活工作——HMR 重载绝不能把它们误认为孤儿——恢复的 stopping 记录只记为 abandoned，不会重启或发送通知。
2. 按 `ownerSession` 分组并解析每个属主：存活 agent（`ctx.agents.get`）；否则通过不占用写入所有权的 `sessionPersistence.open(id, 'read')` 句柄打开并读取已存储的会话；否则是孤儿。读取句柄在解析返回前关闭。没有 persistence seam 时属主是*未知*而非孤儿：不会仅凭证据缺失就结算或驱逐任何记录。
3. 策略决定每条待处理记录的命运。`resumeOnBoot: false` 全部结算。孤儿属主的记录以 `'owner-unavailable'` 结算。每个属主最旧的前 `maxResumedRunsPerOwner` 条保持*可收养*，等待其 kind 的生产方 resumer；超出的部分以配额详情结算，使重启不会冲破注册表的每属主并发上限。
4. 收养本身属于生产方：返回 hooks 的 `registerResumer` 处理器以原 id 重新收养记录，注册表在重新盖章的记录提交后通过 `onJobAdopted` 通告——并等待记账完成才接上生产方的完成接线——supervisor 据此记为 `run/resumed`。标记写入是必需的：store 拒绝该写入时续跑会诚实地失败，而不是让收养无标记运行。没有任何一趟流程观测到的收养——在 supervisor 挂载前就已触发的 resumer，或记账前就已消亡的进程——会在记录上留下持久的 `adoptedFromIncarnation` 标记。下一趟流程将其记为 `run/resumed`，并指明该先前 incarnation。若工作流在 stopping 时搁浅，则随后以实际运行已收养工作的 incarnation 补齐 workflow closer 和 `run/abandoned`，使后续启动找到同一条 abandoned 账目；其他终态 killed 工作流会直接得到 `run/abandoned` 与 workflow closer，而不会虚假声称已恢复。只有 account 及所需 workflow closure 确认写入或已存在后才清除标记；任何通道都触及不到的属主或 append 失败会把标记留给之后的启动。拒绝或抛错的 resumer 记为 `reason: 'resume-failed'` 的 `run/abandoned`。
5. 截止时仍待处理的记录以 `'reconcile-timeout'` 结算——这趟流程总会完成，进程总会启动。

supervisor 驱动的结算走注册表的 `registerResumer` 拒绝通道：terminal 记录 first-wins、`reported` 保留、完成监听器照常通知。该通道一次回放整个 kind，因此当某 kind 仍有可收养记录待处理时，其结算目标会等到它们resolve或截止。

<a id="model-visible-account"></a>
## 持久账目与模型通知

这里声明三个 log-only 会话事件（以声明合并并入 `SessionEventMap`，均非 `ignorable`——不认识某个 run 结局的读取方必须拒绝该日志）：

- `run/resumed`——一个 run 活过了宿主进程并被重新收养，携带写下该记录的 `priorIncarnation`。
- `run/abandoned`——一个 run 被诚实结算，携带 `reason`（`'not-resumable' | 'owner-unavailable' | 'reconcile-timeout' | 'resume-failed'`）和人类可读的 `detail`。
- `run/detached`——在此声明以便 `run/*` 词汇有唯一的家，但它由后续的 workflow 切片发出（`ownership: 'supervisor'` 下的 `dsh-tool-workflow`），本插件从不发出它。

事件经由可达的通道进入属主会话：agent 已注册时走存活会话 append，并在确认账目前通过 `ctx.sessions.flush(session)`；否则通过独占的 `sessionPersistence.open(id, 'write')` 句柄读取下一个 seq、追加、flush 并关闭，之后才确认账目。离线操作失败时，若会话已转为存活，则重试存活通道。flush 失败会保留收养标记，留待后续启动处理。同一 job incarnation 的账目是非对称的：已有的 `run/abandoned` 可以满足后续 `run/resumed` 重试，但 `run/resumed` 永远不会阻止后续的 `run/abandoned` 结算。已存在的同类型事件不会重复写入，因此反复重启不会重复任一账目。

未被报告的终止记录还欠属主恰好一条完成通知——若持久的 `reported` 标志表明模型已收讫，则一条也不发。通知只投递给存活属主（注入式，形状与 `dsh-tool-jobs` 的完成通知一致，但来源标记为 `plugin: 'run-supervisor'`），随后 supervisor 经注册表把该记录认领为 reported，使后续启动不会重复投递。对可恢复但未存活的属主，持久的 `run/abandoned` 事件仅记入会话日志，不会自行进入模型消息历史。属主下次恢复时可通过任务工具查看已恢复的任务。

带围栏的公开注册表接口不接受自定义 terminal 详情，因此由 supervisor 结算的记录携带注册表自己的诚实详情（`'not resumable after host restart'`），而精确原因记录在 `run/abandoned` 事件与通知文本里。会话事件是持久账目；只有完成通知和任务工具结果对模型可见。

<a id="orphan-retention"></a>
## 孤儿保留

当终止记录的属主会话既无法存活命中、也无法被 persistence 列出时，自其结算起超过 `orphanRetentionMs` 后（`0` 表示首个可分类的启动即驱逐），把它从持久 store 中驱逐。内存中恢复出的副本会驻留到进程退出，但它被围栏在已死的会话里、对任何调用者都不可见；持久驱逐才是跨启动约束孤儿可被列出时长的机制。

<a id="config"></a>
## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `resumeOnBoot` | `true` | 启动时恢复可恢复的 run；`false` 诚实结算所有上一 incarnation 的待处理记录 |
| `bootResumeTimeoutMs` | `30000` | 约束整趟 reconcile；剩余部分以 `'reconcile-timeout'` 结算 |
| `maxResumedRunsPerOwner` | `10` | 启动时每属主的收养预算；超出部分诚实结算 |
| `orphanRetentionMs` | `604800000`（7 天） | 诚实结算的孤儿记录在持久 store 中保留的时长 |

<a id="model-experience"></a>
## 模型体验

间接影响，因为启动结果通过存活属主的完成通知及 [`dsh-tool-jobs`](../tool-jobs/README.zh.md) 结果进入模型上下文，而 `run/*` 事件仅留在日志中，不消耗模型 token。

#### KV Cache effect

仅记录日志的事件不会改变模型消息或其缓存前缀。已接纳的通知和任务工具结果追加到模型历史，不替换先前的消息。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **每属主预算只约束 supervisor 结算的部分**——在结算扫描之前注册的生产方 resumer 会回放并可能收养其 kind 的全部待处理记录（注册表回放以 kind 为粒度）；`maxResumedRunsPerOwner` 管的是哪些记录保持待处理以等待被收养，而非生产方自己的回放。
- **结算目标与所在 kind 同节奏**——拒绝通道一次结算整个 kind，因此当 kind 仍有可收养记录时，目标会等它们resolve或截止，而非立即结算。
- **被恢复的 run 不会挂到恢复后 agent 的生命周期上**——注册表在 `start()` 时绑定属主清理，被恢复的记录不持有存活属主：dispose 属主 agent 不会取消已恢复的工作（任务工具与注册表 teardown 仍能触及它）。
- **不阻塞首轮，也不在恢复时重放通知**——reconcile 不阻塞属主的第一个模型轮次，也不监听之后的属主挂载。离线账目保留在日志中；仅恢复会话既不会把账目投影到模型历史，也不会注入完成通知。
- **存活会话记账需要持久化监听器**——缺少 Session store，或 flush 没有监听器时，账目不会被确认。flush 拒绝时保留收养标记；若 supervisor 拒绝确认账目，注册表不会启动对应的生产方。
- **通知只注入、从不唤醒**——唤醒预算归 `tool-jobs` 所有，因此启动时不会唤醒空闲的已恢复属主；它的通知留在收件箱里等下一轮。
- **组合顺序是契约**——若挂在 `jobs-local` 的 store 收养之前，这趟流程会发现注册表尚未恢复的记录，告警一次并跳过，直到下次 store 激活。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

本插件不发布运行时 invariant 伴生插件，因为它通过公开服务 seam 暴露持久存储与 reconcile 行为；包测试直接覆盖生命周期。

</details>

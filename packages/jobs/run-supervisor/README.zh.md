---
description: "供维护者配置恢复策略、模型可见账目与孤儿保留的持久任务启动 reconcile 消费方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-supervisor

[English](README.md) | 中文

## 概述

持久任务注册表的启动 reconcile 消费方。宿主重启后，[`dsh-jobs-local`](../jobs-local/README.zh.md) 会在 [`ctx.jobStore`](../jobs-store-domain/README.zh.md) 之上恢复持久记录——终止态原样恢复、上一 incarnation 的不可恢复记录立即诚实结算、上一 incarnation 的可恢复记录留给生产方的 `registerResumer` 处理器——并刻意止步于此：注册表不持有会话感知，也不持有策略。本插件负责剩下的部分：解析每条被恢复记录的属主会话、决定哪些待处理记录仍可被收养、诚实结算其余记录，并把每个结果记录到模型能看见的地方。

请把它挂载在宿主组合的 `jobs-local` 与 `jobs-store-domain` 之后：reconcile 在 store 服务激活时触发，而注册表自己的 store 收养（更早注册的 inject fiber）必须先运行。注册表从未恢复的记录（`persist: false`，或行顺序排错的组合）会被记录一次日志并原样保留。

## 目录

- [启动 reconcile](#boot-reconciliation)
- [面向模型的账目](#model-visible-account)
- [孤儿保留](#orphan-retention)
- [配置](#config)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="boot-reconciliation"></a>
## 启动 reconcile

每次 store 激活执行一趟，全程受 `bootResumeTimeoutMs` 约束：

1. 枚举 store 中 `incarnation` 不同于 `PROCESS_INCARNATION` 的非终止记录。同 incarnation 的记录是进程内的活工作——HMR 重载绝不能把它们误认为孤儿——而终止态记录无需驱动。
2. 按 `ownerSession` 分组并解析每个属主：存活 agent（`ctx.agents.get`）；否则走真实恢复路径可恢复的会话（`ctx.sessionPersistence.prepare)，立即 dispose——可恢复性这个事实才是目的，而非会话对象）；否则是孤儿。没有 persistence seam 时属主是*未知*而非孤儿：不会仅凭证据缺失就结算或驱逐任何记录。
3. 策略决定每条待处理记录的命运。`resumeOnBoot: false` 全部结算。孤儿属主的记录以 `'owner-unavailable'` 结算。每个属主最旧的前 `maxResumedRunsPerOwner` 条保持*可收养*，等待其 kind 的生产方 resumer；超出的部分以配额详情结算，使重启不会冲破注册表的每属主并发上限。
4. 收养本身属于生产方：返回 hooks 的 `registerResumer` 处理器以原 id 重新收养记录，注册表在重新盖章的记录提交后通过 `onJobAdopted` 通告——并等待记账完成才接上生产方的完成接线——supervisor 据此记为 `run/resumed`。标记写入是必需的：store 拒绝该写入时续跑会诚实地失败，而不是让收养无标记运行。没有任何一趟流程观测到的收养——在 supervisor 挂载前就已触发的 resumer，或记账前就已消亡的进程——会在记录上留下持久的 `adoptedFromIncarnation` 标记；下一趟流程将其记为 `run/resumed`，以该前 incarnation 命名，并且只有在 append 被确认已记录或发现已存在后才清除标记——任何通道都触及不到的属主会把标记留给之后的启动。拒绝或抛错的 resumer 记为 `reason: 'resume-failed'` 的 `run/abandoned`。
5. 截止时仍待处理的记录以 `'reconcile-timeout'` 结算——这趟流程总会完成，进程总会启动。

supervisor 驱动的结算走注册表的 `registerResumer` 拒绝通道：terminal 记录 first-wins、`reported` 保留、完成监听器照常通知。该通道一次回放整个 kind，因此当某 kind 仍有可收养记录待处理时，其结算目标会等到它们resolve或截止。

<a id="model-visible-account"></a>
## 面向模型的账目

这里声明三个 log-only 会话事件（以声明合并并入 `SessionEventMap`，均非 `ignorable`——不认识某个 run 结局的读取方必须拒绝该日志）：

- `run/resumed`——一个 run 活过了宿主进程并被重新收养，携带写下该记录的 `priorIncarnation`。
- `run/abandoned`——一个 run 被诚实结算，携带 `reason`（`'not-resumable' | 'owner-unavailable' | 'reconcile-timeout' | 'resume-failed'`）和人类可读的 `detail`。
- `run/detached`——在此声明以便 `run/*` 词汇有唯一的家，但它由后续的 workflow 切片发出（`ownership: 'supervisor'` 下的 `dsh-tool-workflow`），本插件从不发出它。

事件经由可达的通道进入属主会话：agent 已注册时走存活会话 append，否则经 `sessionPersistence` 以日志的下一个 seq 做持久离线 append（若会话在 append 期间转为存活，则重试存活通道）。已经携带该 job 的 run/* 事件的日志不会被重复写入，因此反复重启不会重复账目。

未被报告的终止记录还欠属主恰好一条完成通知——若持久的 `reported` 标志表明模型已收讫，则一条也不发。通知只投递给存活属主（注入式，形状与 `dsh-tool-jobs` 的完成通知一致，但来源标记为 `plugin: 'run-supervisor'`），随后 supervisor 经注册表把该记录认领为 reported，使后续启动不会重复投递。对可恢复但未存活的属主，持久的 `run/abandoned` 事件本身就是账目：会话下次恢复时，模型会在自己的历史里遇见它。

带围栏的公开注册表接口不接受自定义 terminal 详情，因此由 supervisor 结算的记录携带注册表自己的诚实详情（`'not resumable after host restart'`），而精确原因记录在 `run/abandoned` 事件与通知文本里。这是刻意的：会话事件是面向模型的账目，记录详情则如实说明是哪条通道结算了它。

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

Indirectly, through the `run/*` session events and completion notices appended to the owner session, which the session log and [`dsh-tool-jobs`](../tool-jobs/README.zh.md)-shaped notices render into the transcript like any other completion.

#### KV Cache effect

没有直接的失效；追加的事件和每条未报告结算的一条通知会像普通完成一样接在属主会话末尾，模型下一轮即可读到。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **每属主预算只约束 supervisor 结算的部分**——在结算扫描之前注册的生产方 resumer 会回放并可能收养其 kind 的全部待处理记录（注册表回放以 kind 为粒度）；`maxResumedRunsPerOwner` 管的是哪些记录保持待处理以等待被收养，而非生产方自己的回放。
- **结算目标与所在 kind 同节奏**——拒绝通道一次结算整个 kind，因此当 kind 仍有可收养记录时，目标会等它们resolve或截止，而非立即结算。
- **被恢复的 run 不会挂到恢复后 agent 的生命周期上**——注册表在 `start()` 时绑定属主清理，被恢复的记录不持有存活属主：dispose 属主 agent 不会取消已恢复的工作（任务工具与注册表 teardown 仍能触及它）。
- **没有首轮闸门**——host 平面上没有 seam 能让 supervisor 阻塞属主会话的第一个模型轮次；在标准启动顺序里，reconcile 在宿主启动时、agent 组合恢复会话之前运行，而持久的离线 append 保证账目在会话下次加载时可见。
- **通知只注入、从不唤醒**——唤醒预算归 `tool-jobs` 所有，因此启动时不会唤醒空闲的已恢复属主；它的通知留在收件箱里等下一轮。
- **组合顺序是契约**——若挂在 `jobs-local` 的 store 收养之前，这趟流程会发现注册表尚未恢复的记录，告警一次并跳过，直到下次 store 激活。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

# Agent Note: Session control queue projection coalescing

Status: implemented

[English](2026-08-30-control-queue-projection-coalescing.md) | 中文

## Problem

每一代 control stream 都会把广播的 frame 按 consumer 排队，直到该 consumer 排空它们。在繁忙的 host 上——一次长时间的同步查询、一个停滞的标签页——每个已提交事件都会重算的 projection 单元（token-meter 的 usage、pressure、breakdown，外加列表元数据单元）产量超过其他所有 control 流量，于是一个落后的 consumer 的队列里堆满了 projection frame，而它们在 client 侧唯一的命运是被丢弃：client 的 projection store 按 seq 高者获胜应用 frame（`seq <= current ? 忽略 : 替换`），使得每个 `(session, key)` 除最新帧外的所有排队帧都纯粹是投递成本。每次事件的扇出内存、排空与序列化开销都随 consumer 数量放大，即使这些 consumer 已经跟不上。本次扩展所基于的 control-stream 词汇记录在 [Session 历史与事件传输笔记](2026-08-18-session-history-and-event-transport.zh.md)。

## Decision

**每个按 consumer 的 control queue 都会从物理结构中摘除被取代的带键节点；只有 `projection` frame 带有可取代身份。** 每次推送先经过 `controlSupersedingKey`（`packages/api/session-controller/src/control.ts`），该函数是安全性判定的唯一所有者。队列以双向链表保存节点，并用按 Session id 与 projection key 分层的 map 索引尚未投递的带键节点。同一元组的新 frame 会以 O(1) 摘除旧节点，立即释放旧 frame 及其队列位置，且不移动任何幸存节点。即使任一组成部分含有 NUL，不同元组也不会碰撞。排空只访问可投递节点，在投递幸存节点时删除其 map 项；`end()` 清空索引。非 projection 的 frame 永不合并、重排或丢弃。

**判定恰好只接纳一种 frame。** `projection` 合格，因为它携带单元的完整（COMPLETE）成品值以及计算时所在的水位 seq：在队列内被更新帧赶上的 frame，恰好就是 client 的 seq 高者获胜规则在到达时会丢弃的 frame，因此丢弃它不改变任何可观察状态。它也是唯一产量足够大的种类。`queue` 与 `jobs` frame 是整体快照式的新者胜值，合并它们本来也安全，但它们只在罕见的用户或注册表动作时触发，没有可节省的帧；而把 job 的 `running -> stopping -> killed` 推送串合并掉还会白白丢掉一个可见的状态迁移。`baseline` 从不进入队列：每一代都直接产出它。

**一个可选基准测试为扇出定价。** `apps/web/tests/host-control-fanout.perf.ts`（手动 `test:web:perf` 通道，纳入 host 编译面检查）播种约 1,560 个会话的目录和一段约 1,724 个事件的会话，然后在 0–8 个 SessionControlController consumer 下，用 `blocked` 突发（追加之间不排空）与 `paced` 突发（每个已提交事件后都排空）夹住所有队列策略效应。它只报告测量值而不做时序断言——host 速度不是正确性契约——结构性断言固定投递状态：每个 consumer 恰好打开一代覆盖整个目录的 baseline，永不丢失任何键的最新值或最新 seq，永不出现 seq 回退，且收到与其他 consumer 完全一致的流。paced 模式下投递量等于实时推送普查；blocked 模式下每个键恰好只投递最新一帧。

## Alternatives considered

**把 queue 与 jobs frame 也合并。** 否决：两者都按用户或注册表动作触发而非按事件触发，没有可节省的帧；而合并掉 `running -> stopping -> killed` 推送串会隐藏 jobs 面板所渲染的状态迁移。`controlSupersedingKey` 记录了这条排除，使未来的高速率种类被刻意接纳，而非默认放行。

**在数组缓冲区中留下空 slot。** 否决：这种做法会释放被取代的 frame，但每次推送仍留下一个墓碑，使停滞 consumer 的物理队列基数继续随突发规模线性增长，最终排空也必须扫描每一次取代。链表节点既能保持所有幸存 frame 的相对顺序，也能以常数时间移除。

**维持只在 client 丢弃。** 否决：host 要为 client 到达即弃的 frame 支付按 consumer 的队列内存、排空与序列化——基准测试的 blocked 行显示每次突发约 1,050 个推送帧合并为每个 consumer 4 个投递帧，因此节省的是负载下的常见情形，而非边角情形。

## Consequences

停滞或缓慢的 consumer 不再放大 projection 队列大小或投递成本：物理带键节点基数与 blocked 模式投递量都按 `(session, key)` 保持恒定而非随突发规模增长，排空工作也不包含被取代的节点。queue 与 jobs frame 按推送顺序到达且无一丢失；abort 仍然丢弃缓冲区；host 拆除仍然冲刷幸存的最新的帧；每代 baseline 的契约不变。client 无需改动——它的 seq 高者获胜规则本就同等对待"从未投递的旧帧"与"到达即弃的帧"，而每个 projection consumer 都收敛到每个键相同的最新值。

## Verification

`control-coalescing.host.spec.ts` 对 100,000 次推送后的物理队列基数、含 NUL 的碰撞形 Session/key 元组、blocked 合并后每键只投递最新值、跨 blocked 批次的 seq 单调递增、跨会话不合并、queue frame 在被合并的 projection 旁保持顺序与完整、wake 与排空之间发生的取代仍然生效、abort 丢弃缓冲区，以及拆除时只冲刷每键最新的缓冲帧进行固定。`session-projections.host.spec.ts` 通过在追加之间排空保持 paced 的逐单元推送契约。基准测试在两种节奏模式下都对照实时的注册表推送普查断言每个 consumer 的投递，并在 host 编译面中运行。

# Agent Note: code-runtime 的墙钟上限只统计空闲时间

Status: implemented

[English](2026-08-19-idle-aware-code-runtime-wall-ceiling.md) | 中文

## Problem

worker-thread code runtime 强制执行的两个预算，对「宿主代表程序完成的工作该不该计费」给出了相反的答案。`computeMs` 读取 worker 实测的事件循环活跃时间，因此程序等待慢速 binding 时不累计；`maxWallMs` 则是一个普通的 `setTimeout`，把每一毫秒都计入，包括宿主在程序调用的 binding 内部花掉的时间。

这种不对称会杀死正确的程序。一个整个函数体只有 `await tools.workflow(...)` 的 `run_code` 程序——一次 dispatch 扇出七个 subagent——没有累计任何忙碌时间，却仍以 `wall-clock ceiling reached (600000ms)` 失败。结算会终止 worker，且运行的中止路径会传播到进行中的调用，因此同一次到期还取消了该 workflow（`workflow run cancelled: workflow signal aborted`），销毁了已经完成的下游工作。每一次耗时较长的宿主 dispatch——workflow、subagent、`bash` 下的慢速构建——都会遇到同样的失败，而只调大数值只能把问题往后挪。

## Decision

`maxWallMs` 是空闲上限：它只统计运行中**没有任何宿主 binding dispatch 未完成**的时间段，从而与 `computeMs` 对称。程序等待 dispatch 时等的是宿主认可的工作，而不是空转，因此两个预算都不对其计费。它剩下的用途没有改变，也正是该上限一直以来的目的：结束一个在等待永远不会 resolve 的 promise 的程序。失败标识不变——`kind: 'timeout'`，消息为 `wall-clock ceiling reached (${maxWallMs}ms)`。

宿主在 `packages/code-runtime/code-runtime-worker-thread/src/index.ts` 中跟踪未完成的 dispatch。`onCall` 在重复 id 检查之后开始一次 dispatch，因此伪造的重复 id 永远不会被计数，并在每次调用的 `reply` 闭包中、于该闭包结算后的丢弃逻辑之前结束它。每个 call id 按构造恰好由一次 `reply` 应答：binding 调用会 resolve 出回复负载——成功、两种无损 JSON 拒绝之一，或由外层 `catch` 渲染的抛出与 reject——而不是在自己的 `try` 内部投递；未知 binding 名称与有损参数各自回复一次后返回。第一个未完成的 dispatch 会清除定时器，并把已过去的时间段加入该运行累计的空闲总量；计数回到零时按 `maxWallMs` 减去该总量重新武装定时器，因此短 dispatch 与空闲间隔交替出现的程序仍会到期。运行结算后不再重新武装，于是 `finish` 仍是最终裁决，也不会遗留悬挂定时器。每次重新武装的延迟都是 `maxWallMs` 的余量，而加载期检查已用 `MAX_TIMER_DELAY_MS` 为其设界，因此任何武装路径都不会被夹到 1 ms。

默认值从 600_000 提高到 3_600_000。在只统计空闲的口径下，这个值回答的是另一个问题——一次运行在被判定为卡死之前，可以在无事可做的状态下停留多久——它不再与合法宿主工作的时长相竞争。它仍是带校验的 `Config` 字段，保留正数与 `MAX_TIMER_DELAY_MS` 检查。

`computeMs` 未作改动：它仍读取实测忙碌时间，因此无论是否有诱饵 dispatch 在途，热循环都会被终止。

## Testing

`packages/code-runtime/code-runtime-worker-thread/tests/runtime.spec.ts` 固定了定义该上限的四种行为：在 2_000 ms 的上限下，等待 binding 5_000 ms 的程序仍能完成；没有任何未完成工作的永久空闲程序仍以 `wall-clock ceiling` 失败；以瞬时 dispatch 与 300 ms 间隔交替的程序，在间隔累计达到 1_000 ms 上限时失败；在 `computeMs` 高于 `maxWallMs` 时，带未完成 dispatch 的热循环以 `compute budget` 失败。第五个用例在 1_500 ms 的上限下让 1_000 ms 与 5_000 ms 两个 dispatch 重叠，只有计数（而非每次 dispatch 的标志）才能让上限在较早的那次回复之后仍保持挂起。

永久空闲的 fixture 在程序内部用 `new Promise(() => {})` 空转，而不是等待一个永不 resolve 的 binding。永不 resolve 的 binding 属于未完成的 dispatch，在宿主侧与慢速 dispatch 无法区分，因此它不再描述一次空闲运行。

## Alternatives considered

**调大 `maxWallMs` 并保持其无条件生效。** 最省事的改法，但依然是错的：它只是给缺陷重新定价，而没有消除它。任何低于最长合法 dispatch 的上限都会杀死正确的程序，而高于它的上限又不再约束该上限存在的那个空闲情形。

**每次回复都重置该上限。** 比累计空闲更简单，且无界：一个以 1 毫秒 dispatch 与低于上限的空闲间隔交替的程序会永远运行下去。把已消耗总量向前累计，可以让整个运行只有一个预算。

**像计算预算那样用轮询来统计空闲时间。** 为了得到 dispatch 计数已经精确给出的结果而再加一个间隔定时器，还会带来该上限并不需要的到期粒度。

**改为限制单次 dispatch。** 在 code runtime 内部做单次 dispatch 超时，会与消费方已经拥有的 tool-timeout 策略重复，而且必须为合法时长相差数个数量级的工具猜一个界。

## Consequences

一个把生命都花在宿主 dispatch 里的程序，其边界由宿主 binding 本身、由 `computeMs`（针对它自己计算的部分）以及请求的 abort 信号决定，而不再由一个看不见它在等什么的时钟决定。促成这次修改的 workflow、subagent 和长构建程序都能完成。

永不结算的宿主 binding 现在会让其运行一直挂起：只要该 dispatch 未完成，上限就保持挂起，运行只能通过请求的 abort 信号或运行时释放结束。为单次 dispatch 设界属于拥有该 binding 的消费方；包 README 记录了这一缺口。

该上限不再是通用的整体运行超时，需要总耗时上界的调用方必须通过自己的信号提出。收容能力没有变化：每条结算路径仍会终止 worker，输出账本未受影响，且恶意对端既无法重复计数也无法泄漏 dispatch，因为 id 至多被计一次，且每个被应答的 id 恰好产生一次回复。

[Code Mode Agent Note](../feature/2026-06-15-code-mode.md) 拥有双预算这一决策，并已记载修正后的 `maxWallMs` 语义。

# Agent Note: 在 pi-ai 上下文溢出错误中浮现解析出的容量与用量

Status: implemented

[English](2026-08-25-pi-ai-context-overflow-diagnostics.md) | 中文

## 问题

当 pi-ai 的 `isContextOverflow` 在没有提供方错误措辞的情况下检出基于用量的溢出——一次 `stop` 的输入加缓存读取用量超过解析出的上下文窗口，或一次零输出的 `length` 停止恰好填满窗口——`dsh-llm-pi-ai` 的 `mapStopReason` 只能拼出一条泛泛的本地消息：`pi-ai detected context overflow for model "<model>"`。适配器其实早已解析出目录中的上下文窗口并传入映射，触发检测器的用量也就在消息上，但两者都没有到达读者。用户只被告知*发生了*溢出，却不知道容量和消耗，消息给不出任何可以采取行动的起点。

该行为此前是 `apply-rc6-context-overflow-diagnostics` 编译产物补丁的一部分，在升级到上游 0.1.1-rc.2、退役编译补丁时被一并悄悄丢弃。本笔记记录把该补丁的 pi-ai 溢出部分在源码中重新落地。

## 决策

本地兜底消息现在写明解析出的容量和触发溢出的用量：`pi-ai detected context overflow for model "<model>" at resolved context window <N> tokens (input <I>, cache-read <C>)`。提供方给出的溢出文本仍然原样优先（`message.errorMessage`），因为它带着提供方自己的数字。

插值的值不需要 `unknown` 兜底，加上反而是死代码：兜底路径上 `message.errorMessage` 必然缺省，而 pi-ai 的检测器在没有错误措辞时只为两种用量对比窗口的情形触发，两者都要求已解析的 `contextWindow`；`usage` 在 pi-ai 的 `AssistantMessage` 上是必填字段。不可达的兜底分支还会破坏 `packages/*/*/src` 的逐文件 100% 覆盖率门禁。

消息只插值模型 id 与整数计数——绝不包含请求或响应内容——因此该诊断不会泄漏提示词载荷或凭据。`convert.spec.ts` 中的聚焦断言与 `adapter.spec.ts` 中的目录窗口适配器测试钉住了新措辞，包括一个能在消息中看到缓存读取份额的 length 停止用例，以及一个恰好等于窗口时仍为成功停止的边界用例。`context-overflow-diagnostic` 会话快照回放了一个以可操作错误 finish 结束的轮次——失败的压缩恢复保留了原始失败——证明该诊断会持久化到会话日志与 headless 的 stderr 投影中。

## 否决的替代方案

**报告检测器拿来与窗口比较的输入加缓存读取合计值。** 否决：分列的字段如实陈述了测量值而不掩盖构成；想减用量的读者需要知道哪个桶占大头。

**给每个插值字段都加 `?? "unknown"` 兜底，照抄历史编译补丁。** 否决：补丁打的是类型已擦除的编译 JavaScript；在源码中，兜底路径上可证必有已解析的窗口和填好的 `usage`，多余分支不可达且会破坏覆盖率。

**保留泛泛消息，指望随后的压缩自行解释。** 否决：溢出错误是用户看到的第一条、有时也是唯一一条诊断；压缩在更晚才运行，无法回溯地让最初的失败变得可操作。

## 后果

- 本地溢出错误现在带上采取行动所需的数字（削减输入、清理缓存沉重的历史，或改用更大窗口的模型），无需复现该轮次。
- 消息变长了，但仍是一句只陈述事实的话；带提供方措辞的溢出错误不受影响。
- 措辞由转换测试和适配器测试钉住，将来上游升级若重新生成映射，无法在不导致测试失败的情况下把它静默改回泛泛文本。

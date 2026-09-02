# Agent Note：后台结算通知说明失败原因

Status: implemented

[English](2026-08-25-background-settlement-diagnostic.md) | 中文

## 问题

失败的后台子代理只会告诉父代理 `Background subagent <id> failed before it finished.`。原始拆卸诊断本来存在，却没有被转发：`ActivationTerminal` 携带 `stopReason` 与 `output`，但没有承载失败信息的成员，因此 `lifecycle.ts` 中的 `terminal(failure)` 把每一次拆卸失败都映射为裸的 `{ stopReason: 'error' }`，抛出的值被直接丢掉。已捕获的已知 LLM 错误会携带类型化的 `QUOTA` 或 `RATE_LIMIT` 事实；仍未分类的已捕获错误可能没有类型化 failure。

一次性工具路径并不会丢失它——`stopReasonError` 会经由 `withDiagnosticAndPartialText` 与 `SubagentResult.diagnostic` 及子代理的部分文本拼接。只有后台投递路径是盲的，而这正是包约定所警告的不对称。

代价是归因错误，且并非假设。当某个供应商路由达到配额上限时，连续六个后台子代理都只留下那一句话。父代理无法区分配额耗尽、作用域崩溃与进程被杀，于是先诊断为主机内存，再诊断为代理上下文上限，并向同一个不可用路由重新派发了四次。这些重试全都可以避免：底层错误早已说明了问题。

## 决定

`ActivationTerminal` 增加可选的 `diagnostic`，仅在拆卸失败这一边被填充；`settlementSummary` 将其以 ` Reason: <text>` 追加到 `error` 语句之后。文本取失败自身的 `String(failure)`，上限 4096 UTF-8 字节——与 `SubagentResult.diagnostic` 所记载的上限一致，也与一次性路径已通过 `detail: String(error)` 报告的细节一致。

原因只在子代理无法自述时附加。经由自身回合结束的 epoch 仍报告 `captured`，其 `stopReason` 由子代理自己的事件推导；这类结束对父代理而言已体现在子代理输出中，无需再合成解释。

## 备选方案

**将每次失败都分类为代码——配额、传输、崩溃。** 否决：只有已知 LLM 原因会被分类为 `QUOTA` 或 `RATE_LIMIT`；原始拆卸诊断仍以可读文本保留，未分类的已捕获错误可能没有类型化 failure。更宽泛的分类法需要供应商专属类别，还会让消费者基于猜测分支。

**包含失败的调用栈。** 否决：父代理是一个决定重试还是改道的模型，调用栈对该决策属于传输层噪声，同时提高了把环境路径带入通知的风险。

**原样、不设上限地报告抛出值。** 否决：diagnostic 契约规定 4096 字节上限，正是因为供应商载荷可能任意大，而通知会进入父代理的上下文窗口。

## 验证

`packages/subagent/subagent/tests/continuation.spec.ts` —— 'withholds an outcome the harness could not durably release' 注入一次处置失败，并断言父代理的通知携带 `Reason: SubagentError: subagent "<id>" activation handle disposal failed: scope unwind failed`。周边用例断言源自子代理自身回合的结束保持原有文本。

## 影响

编排后台子代理的父代理能够读取原始拆卸诊断，并在捕获到已知 LLM 原因时基于 `QUOTA` 或 `RATE_LIMIT` 分支——停止向已耗尽的路由重复派发、改用其他供应商，或把配额问题呈报给人。未分类的已捕获错误没有类型化 failure。通知仅在失败这一边增加一句有上限的说明。

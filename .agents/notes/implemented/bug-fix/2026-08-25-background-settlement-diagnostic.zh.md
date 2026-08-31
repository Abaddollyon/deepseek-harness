# Agent Note：后台结算通知说明失败原因

Status: implemented

[English](2026-08-25-background-settlement-diagnostic.md) | 中文

## 问题

失败的后台子代理只会告诉父代理 `Background subagent <id> failed before it finished.`。原始拆卸诊断本来存在，却没有被转发：`ActivationTerminal` 携带 `stopReason` 与 `output`，但没有承载失败信息的成员，因此 `lifecycle.ts` 中的 `terminal(failure)` 把每一次拆卸失败都映射为裸的 `{ stopReason: 'error' }`，抛出的值被直接丢掉。已捕获的已知 LLM 错误会携带类型化的 `QUOTA` 或 `RATE_LIMIT` 事实；仍未分类的已捕获错误可能没有类型化 failure。

一次性工具路径并不会丢失它——`stopReasonError` 会经由 `withDiagnosticAndPartialText` 与 `SubagentResult.diagnostic` 及子代理的部分文本拼接。只有后台投递路径是盲的，而这正是包约定所警告的不对称。

代价是归因错误，且并非假设。当某个供应商路由达到配额上限时，连续六个后台子代理都只留下那一句话。父代理无法区分配额耗尽、作用域崩溃与进程被杀，于是先诊断为主机内存，再诊断为代理上下文上限，并向同一个不可用路由重新派发了四次。这些重试全都可以避免：底层错误早已说明了问题。

## 决定

`ActivationTerminal` 增加可选的 `diagnostic`，仅在拆卸失败这一边被填充；`settlementSummary` 追加固定句子 ` Reason: Subagent teardown failed.`。该文本标识基础设施失败，但不会把异常消息、凭据、路径、协议载荷或注入指令转发到父会话。类型化失败恢复另行通过数据描述符遍历有界的 `cause` 与 `AggregateError.errors` 图，并包含恶意 Proxy 陷阱。

原因只在子代理无法自述时附加。经由自身回合结束的 epoch 仍报告 `captured`，其 `stopReason` 由子代理自己的事件推导；这类结束对父代理而言已体现在子代理输出中，无需再合成解释。

## 备选方案

**将每次失败都分类为代码——配额、传输、崩溃。** 否决：只有已知 LLM 原因会被分类为 `QUOTA` 或 `RATE_LIMIT`；未分类的拆卸错误与已捕获错误没有类型化 failure。更宽泛的分类法需要供应商专属类别，还会让消费者基于猜测分支。

**包含失败的调用栈。** 否决：父代理是一个决定重试还是改道的模型，调用栈对该决策属于传输层噪声，同时提高了把环境路径带入通知的风险。

**报告有字节上限的原始异常文本。** 否决：字节上限只能控制上下文成本，无法移除凭据、私有路径、原始载荷或提示注入文本。基础设施异常保留在内部。

## 验证

`packages/subagent/subagent/tests/continuation.spec.ts` 注入普通处置失败与恶意 Proxy 处置失败，断言父通知仅包含固定原因，并证明嵌套所有权会被释放，从而让祖先完成结算。`failure.spec.ts` 覆盖循环 cause、`AggregateError.errors`、描述符陷阱和已撤销 Proxy，同时保留已知提供方事实。

## 影响

编排后台子代理的父代理可以区分基础设施拆卸失败与普通子代理错误，而不会接收基础设施异常文本。当已知 LLM 原因在拆卸后仍可恢复时，父代理可基于 `QUOTA` 或 `RATE_LIMIT` 分支；未分类错误没有类型化 failure。通知仅在拆卸失败这一边增加一句固定说明。

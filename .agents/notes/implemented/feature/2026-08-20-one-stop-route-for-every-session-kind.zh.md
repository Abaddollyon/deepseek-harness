# Agent Note: One stop route for every session a human can open

Status: implemented

[English](2026-08-20-one-stop-route-for-every-session-kind.md) | 中文

## 问题

人可以在 GUI 中打开一个 subagent 会话,却没有任何方式停止它。

`session.cancel` 对任何 subagent 拥有的会话直接设防,回应一个所有权错误而不是执行取消,其理由是子级的轮次属于其父级。composer 也持相同立场:其主 Send/Stop 切换对子级被抑制,独立的 Stop 控件只对*可继续的*子级出现。因此一次性子级完全没有任何停止控件,而客户端自己的 `cancel()` 对该情形携带一个硬编码的失败。文档记载的途径是 `job_kill`,那是一个面向模型的工具,GUI 并不提供。

这是中断调查的 D10,它叠在 [cancellation-convergence note](../bug-fix/2026-08-20-cancellation-convergence-across-the-agent-tree.md) 记录的两个缺陷之上:一次没有到达子树的停止,以及一个正在结算的子级重新打开了已被停止的轮次。

## 决策

**所有权栅栏变成 cause 选择器,而不是拒绝。** `session.cancel` 现在取消人所指名的任何会话,根据所有权选择 cause 而不是拒绝:会话为 subagent 所拥有时用 `{ kind: 'parent' }`,否则用 `{ kind: 'user' }`,两者都带 `keepInbox: true`。所有者自己的 Agent 不受影响——停止子级不等于停止其父级——而持久化的 cause 如实记录了谁发出请求以及代表谁。

**级联搭乘同一次调用。** `ctx.get('subagents')?.cancelDescendants(sessionId)` 紧随取消之后,因此无论被指名的会话是哪种类型,人发起的停止都会到达其下方整个存活子树。可选服务读取让不含 subagent 的组合保持原样工作。

**composer 向每个存活子级提供 Stop。** 独立 Stop 控件不再以可继续性为门槛,因此一次性子级可以通过与其他任何会话相同的手势被停止。

## 备选方案

**让 GUI 对子级走 `subagent.interrupt`。** 已否决:该端点授权的是一个*持久父级地址*,而 composer 并不总是拥有它——一次性子级的父级可能已离线——而且它是模型的单目标原语,其文档化的作用范围有意比人发起的停止更窄。让人类路径经过它会迫使这两种语义之一被扭曲。

**保留栅栏并在 GUI 中暴露 `job_kill`。** 已否决:job id 是一次性后台委托的实现细节,一个通过一种机制停止某些子级、通过另一种机制停止其他子级的控件,是一个必须向用户解释 harness 内部机制的 UI。

**同时取消所有者,让父级不再继续请求。** 已否决:人指名的是子级。一次悄悄结束父级轮次的停止会摧毁用户并未指向的工作,而父级自己的停止控件只需一次点击。

## 影响

现在人可以打开的每个会话都恰好有一条停止路径、一种语义:停止此会话及其下方一切存活内容,保留队列,不动所有者。subagent 拥有的会话的持久 `turn/end` 记录 `{ aborted, parent }` 而不是 `{ aborted, user }`,这让 cause 忠实于谱系,同时仍是一次人发起的停止;区分用户停止的消费者——其中包括结算通知谓词——读取该 cause,因此被停止的子级结算时其父级仍会被正常唤醒,这是正确的:父级并没有停止。

# Agent Note：Alpha5 rebase 后的 replay 对账

Status: implemented

[English](2026-09-02-replay-reconciliation-after-alpha5-rebaseline.md) | 中文

## 问题

Alpha5 重新落地各 lane 后，replay 暴露两个回归：请求 preflight 异步生成 session 标题时可能消耗脚本的第一条模型响应；组合会话由祖先滚动容器负责滚动时，flow row 上的 content-visibility: auto 会破坏几何计算。

## 决策

## 修复与有意重录

goal-tools 与 subagent-settlement 的 replay override 现在把标题响应放在主脚本响应之前。这是 preflight admission 下的顺序约定，不是产品行为变化。ACP goal goldens 以及 ordinal-4 workflow/tool-schema snapshots 按预期的 b03 事件条件 continuation 与 schema owner 变化重新录制。

ChatView 在独立滚动端口上仍保留 offscreen containment，但当 data-conversation-scroll 成为祖先时禁用它。CSS contract test 同时固定这两个边界，在保留 #33 性能收益的同时避免祖先滚动行被隐藏。

## 考虑过的替代方案

重新录制产品行为被拒绝：响应顺序修复只属于 fixture，而 ACP 与 schema golden 变化是有意的 b03 更新。删除 containment 也被拒绝，因为独立 ChatView 仍受益于 #33。

## 后果

无密钥 replay 再次保留 tool call 与 child settlement 日志；两种滚动所有权模式下 web 几何和 hidden-until-found disclosure 都稳定。ptc-python 与 session-sandbox-root 仍是 tag 中已有的 snapshot 失败，不重新录制。

# Agent Note: 隐藏聊天行的内容隔离

Status: implemented

[English](2026-08-25-chat-row-content-visibility.md) | 中文

## Problem

500 轮会话翻页会挂载约 105,000 个 DOM 节点，并在追加旧页面时将布局耗时推高到约 12 秒。聊天渲染器已经为每个稳定节点隔离了行，但浏览器仍会为所有屏幕外的 Markdown 和工具子树执行布局。

## Decision

聊天流行使用 CSS content-visibility: auto 和 contain-intrinsic-size: auto 240px。浏览器保留稳定行的连续顺序和固有高度估计，同时跳过屏幕外子树的样式、布局和绘制工作。追加路径和 Conversation Node 保持不变，没有新增事件窗口、Context 或 Node 扫描。

## Alternatives considered

**完整 JavaScript 虚拟化**未在本次变更采用，因为它需要新增滚动高度和测量所有者，并为未挂载行实现键盘、查找导航及前置追加锚定。

**移除旧行的 Markdown 和工具详情**被拒绝，因为这会改变检查、无障碍和页内查找行为。

**更大的固有高度估计**被拒绝，因为行首次可见时会增加滚动位置修正；自动记忆的高度可以保持访问过的行稳定。

## Consequences

长会话保留连续的 DOM 顺序、稳定节点身份、键盘导航和页内查找语义，因为行仍然挂载。屏幕外子树的工作会推迟到滚动露出时，浏览器也会在访问行后改进高度估计。这会减少布局工作但不会减少 DOM 节点总数；如果保留的堆或 DOM 数量成为主要成本，完整虚拟化仍应单独决策。

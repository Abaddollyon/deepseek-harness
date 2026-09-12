# Agent Note：功能视图拥有有界的滚动位置

Status: implemented

[English](2026-09-07-feature-view-scroll.md) | 中文

## 问题

对话的活跃视图区可以随聊天记录内容增长。功能视图使用百分比高度的滚动容器时，如果沿用这种布局，外层对话滚动容器就可能保留聊天记录的偏移量，而功能内容却超出视口。较大的成员列表因此会遮住标题和已选详情。

## 决策

[Conversation shell](../../../../packages/client/ui-conversation/README.zh.md#shell-and-standard-props) 标记非 Chat 视图，并通过可收缩的 flex 分配约束视图区。功能模式下，共用的对话滚动容器裁剪溢出内容。Slot outlet 包装元素保留渲染器的 `display: contents`，因此视图区和功能根元素直接参与外层 flex 布局。

功能视图通过 `data-feature-scroll` 标记主滚动容器；未标记时由视图区承担这一职责。滚动位置按原生 environment/session store 身份和 view id 隔离，每个 store 最多保留 32 个视图条目。进入功能视图时清除共用 shell 的偏移量，只恢复该功能的位置。如果异步子内容尚未加载，导致已保存的位置暂时被截断，恢复过程会等待内容。用户的显式输入会终止等待。嵌套输出滚动容器和已卸载视图不能覆盖主滚动位置。

## 考虑过的替代方案

**每次切换都回到顶部。** 这种方式消除了继承的偏移量，却丢失用户在功能标签之间往返时的阅读位置。

**共用聊天记录的滚动位置。** Chat 的锚点和跟随底部策略描述聊天记录行，而非功能列表。功能布局无法合理复用这些位置。

**重新挂载对话根元素。** 重新挂载会把滚动修复与 composer 和草稿生命周期绑定在一起。常驻 shell 和 composer 保持原有身份。

## 影响

只要原生作用域 store 仍然存活，滚动位置就可以跨视图重新挂载保留；这些位置不是跨页面重新加载的持久化偏好。Chat 继续拥有自身的锚点恢复和跟随底部策略。历史[粘性 composer 决策](../../archived/bug-fix/2026-07-29-sticky-composer-conversation-scroll.md) 和 [composer 滚动条留白决策](../../archived/bug-fix/2026-08-04-composer-tab-gutter-reservation.md) 解释 Chat 和 composer 定位的理由；功能裁剪针对外层滚动行为作出限定，并未取代这些决策。

聚焦的 DOM 测试覆盖功能与作用域隔离、嵌套滚动容器、已卸载事件和延迟内容。DOM 测试环境不执行布局，因此长列表、响应式宽度、composer 位置以及标签往返仍需要浏览器几何验证。

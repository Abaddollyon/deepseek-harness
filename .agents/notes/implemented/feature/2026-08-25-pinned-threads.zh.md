# Agent Note: Pinned threads in the workspace sidebar

Status: implemented

[English](2026-08-25-pinned-threads.md) | 中文

## Problem

Codex／Claude Code 风格的置顶会话——把某个 Session 固定到侧边栏顶部——此前只作为 Vesper 针对 `dsh-client-ui-workspace` 的编译产物补丁发布，从未进入核心源码，因此在 rc2 停用编译期运行时补丁后静默消失。其补丁 manifest 规定了行为：置顶保存在浏览器本地、刷新后保留，在分组视图和单列表视图中都渲染于侧边栏顶部的独立分区，且普通会话列表省略已置顶的行，使每个会话恰好出现一次。在核心中重新实现时会与一个已经占用 "pinned" 一词的无关功能相撞：折叠 Workspace 分组在组头下自动保留进行中会话的保留行（`GroupNode.pinned`，`SessionNodeItem` 的 `pinned` prop）。

## Decision

**用户置顶是视图存储状态。** `createWorkspaceViewStore` 新增 `pinnedSessionIds: string[]`（显式置顶顺序）和 `togglePinnedSession` action；持久化键升级为 `dsh.workspace.view.v6`，因为 rehydrate 会整体替换快照，v5 的旧数据会让新字段保持 undefined。置顶只保存在浏览器本地，从不发送给 Host。

**恰好一次的规则由推导层负责。** `TreeView.pinnedSessionIds` 把置顶传入 `deriveGroups`，后者把已置顶的 Session 从每个分组以及折叠组的进行中保留行中排除，同时保留它们的顺序记账槽位，因此取消置顶会回到原先的记账位置。新的 `derivePinnedSessions` 按置顶顺序投影存储的置顶 id，对未知、空白、已归档和 subagent 来源的 id 就地跳过且不改写存储列表，因此被归档的置顶在取消归档后会恢复。`deriveFlat` 刻意保留已置顶的 Session：它为单列表顺序记账提供输入，在那里丢掉某个 id 会让该会话失去手动位置——单列表渲染器只在合并完已存储的顺序后才过滤置顶行，单列表拖拽提交也改写完整的记账顺序而不是渲染行。这正是已停用补丁线的"单列表顺序修复补丁"当年要修复的问题，如今它是一开始的设计形态，而不是事后补救。

**渲染层让两个 "pinned" 概念保持可区分。** 折叠组保留行继续使用 `GroupNode.pinned` 和 `pinned` 行 prop（自动、按分组、仅限进行中）；用户置顶在 `SessionNodeItem` 上新增了明确区分的 `userPinned` prop 和 `onTogglePinned` 回调（行菜单**置顶会话**／**取消置顶**），并在两种浏览模式顶部渲染 `PinnedSessionSection`。两侧的 JSDoc 都点出另一个概念，避免后来的读者把它们混为一谈。

## Alternatives considered

**复用现有的 `pinned` 行 prop 和 `GroupNode.pinned` 字段。** 否决：保留行是自动的、按分组的、仅限进行中的，而用户置顶是显式的、跨分组的、与运行状态无关的；两者共用一个字段会让已置顶且进行中的 Session 渲染两次（置顶分区加折叠保留行），也恰恰制造命名规则要防止的混淆。

**保留 v5 持久化键并在消费端容忍缺失字段。** 否决：存储引擎在 rehydrate 时整体替换状态，每个消费方都得为一个类型上声明存在的字段加 `Array.isArray` 兜底；预发布阶段的立场是用带版本的键而不是兼容垫片。

**在 `deriveFlat` 内部过滤置顶 id。** 否决——这正是已停用补丁的最初形态：单列表顺序记账是从该结果集推导的，置顶 id 会悄无声息地离开已存储的顺序，取消置顶时该会话会被追加到末尾而不是回到原位置。

## Consequences

置顶会把会话的行在其分组或单列表与置顶分区之间移动，任何时刻都恰好渲染一次，包括折叠进行中和当前分组揭示这两种重叠情形；取消置顶会在两种模式下恢复先前位置。持久化键升级的一次性代价是 v5 下保存的浏览器本地视图偏好（展开状态、各记账的顺序）被重置。指向已归档或已删除 Session 的置顶处于惰性状态——处处隐藏但保留在存储列表中——并在该 Session 重新可见时恢复。

## Testing

`tree.client.spec.ts` 固定推导规则（置顶顺序、就地跳过、分组与未分组省略、折叠进行中重叠、位置恢复）。`rows.client.spec.tsx` 覆盖行菜单的置顶／取消置顶二态。`workspace-browser.client.spec.tsx` 覆盖菜单手势、恰好一次渲染、置顶与取消置顶往返的分组与单列表位置恢复、存在置顶 id 时的单列表拖拽、折叠进行中与当前分组揭示这两类重复渲染陷阱、跨重挂载的持久化，以及仅有置顶会话时的空态。

## Related

- [Workspace sidebar order and folding](2026-08-11-workspace-sidebar-order-and-folding.zh.md) —— 拥有本功能不得混淆的折叠组进行中保留行。
- [Current-session group navigation reveal](2026-08-19-current-session-group-navigation-reveal.zh.md) —— 经测试不会与已置顶当前会话重复渲染的揭示路径。

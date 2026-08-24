# Agent Note: The Current Session's Group Opens on Navigation

Status: implemented

[English](2026-08-19-current-session-group-navigation-reveal.md) | 中文

## Problem

侧边栏的 Workspace 分组默认关闭。此前唯一的自动展开是 `SessionTree` 里一个常驻的 `Object.hasOwn(groupExpansion, currentGroup)` effect：它在当前 Session 所在分组首次出现在持久化记录中时把它打开，却永远分不清用户主动折叠与自己尚未见过的分组，因此已被移除。于是只剩组头的折叠开关和该组的 ＋ 按钮能打开分组，而没有任何机制会打开持有用户当前所在 Session 的分组。因此，只要选中 Session 的来源不是那个组头——启动时选中、连接新 Workspace、fork、Host 侧改变选择——该 Session 的行就留在折叠的分组里，侧边栏只呈现一个关闭的文件夹，而屏幕上正在进行的对话没有任何返回入口。折叠分组会保留进行中的行，但保留只覆盖进行中的工作：处于空闲状态的当前 Session 在折叠分组中完全没有呈现。

## Decision

选中某个 Session 会把渲染该行的分组打开一次，作为对一次导航事件的回应。

`WorkspaceBrowser` 根据当前选择计算出一个 `CurrentGroupReveal`：`navigation` 是选中的 Session 与渲染其行的分组键的组合（`tree.ts` 中的 `currentGroupKey`——记账该 Session 的 Workspace，或 Ungrouped 桶），`foldedKey` 则是该分组键，若该分组已打开则为 null。`useCurrentGroupReveal` 记住自己上一次回应过的 `navigation` 值，只在该值变化时才展开。这两项只随用户或 Host 的导航而变化，折叠不会改变其中任何一项：用户手动折叠当前 Session 所在的分组是最终决定，直到选择再次移动为止。这正是该机制要划出的区分——自动展开是对导航的回应，而不是"当前分组必须打开"这一持续不变的约束。

揭示通过 `setGroupExpanded` 展开，也就是组头折叠开关与该组 ＋ 写入的同一份持久化 `groupExpansion` 记录，也是树推导 `GroupNode.expanded` 的唯一依据。这里没有渲染期的覆盖逻辑，因此存储的折叠位与渲染出的 `aria-expanded` 不可能不一致；被揭示打开的分组在重新加载后保持打开，与手动打开的分组完全相同。

揭示会等待 Workspace 列表基线（`phase === 'ready'`）。分组归属由 Workspace 成员关系决定；在基线落地前每个 Session 都读作 Ungrouped，过早行动会打开一个随后被成员关系推翻的桶，并把那个桶一直留在打开状态。

### 为什么由浏览器持有，而非树

只要该区域显示搜索结果、单列表或轨道形态，`SessionTree` 就会卸载。若揭示记录存放在那里，它会在每次重新挂载时被重建，于是从搜索返回树时会重新打开用户刚在树中折叠的分组。`WorkspaceBrowser` 在这三种形态下始终保持挂载，因此已回应的导航恰好与它必须尊重的折叠决定存活同样久。

## Alternatives considered

**改为依赖既有的保留（pinning）机制。** 保留让折叠分组中进行中的行仍可抵达，正在运行的当前 Session 已被它覆盖。但它无法服务导航：其判据是 Session 自身在运行或有正在运行的 subagent 后代，因此空闲的 Session——也就是用户在阅读而非驱动的每个 Session 所处的状态——依然被隐藏。把判据放宽为"进行中或当前"还会在折叠组头下打印一条保留行，而该行对应的对话正占据主列，读起来像是一个没能打开的分组。

**把"当前分组保持打开"当作持续不变的约束。** 用一个在当前分组折叠时就重新展开的 `useEffect` 更短，但那样组头开关对该分组就形同虚设：effect 会在同一次提交中重新打开它，用户的手势被明显驳回。正是导航身份把一次正确的展开与不断重复的展开区分开。

**只用分组作为揭示的键。** 把 Session 从身份中去掉确实能让手动折叠的分组保持折叠，但在该分组内选中另一个 Session 时就不再打开它，而这正是本 Note 要修复的主要缺陷。

**在每个发起导航的调用点各自展开。** 分组的 ＋ 已经会在创建 Session 前展开，模式是现成的。但把它推广到通往 Session 的每条路径，意味着侧边栏选择器、另一个包中的主视觉选择器、启动自动选中、fork，以及未来任何 Host 驱动的选择，都要各自携带这条规则。选择本身才是它们共同产生的那一个事实，因此揭示改为读取它。

**在渲染器中对当前分组覆盖展开状态。** 不写存储、只把当前分组渲染为打开，可以让用户存储的偏好保持不变，代价是同一份折叠状态出现两个账目：组头会汇报 `aria-expanded="true"`，而持久化记录说它是折叠的，下一次切换翻转的是那个看不见的账目。

**为该行为增加配置字段。** 这是一个正确的行为，而不是随部署而变的策略；而且浏览器半侧的 `Config` 今天是无效的：`WebBootEntry` 不携带配置，客户端插件无法从 cordis.yml 获得配置。

## Consequences

- 通往 Session 的每条选中路径都会让它在侧边栏中可抵达，包括新连接的 Workspace 所创建的空白 Session。
- 分组仍然默认关闭；用户对当前 Session 所在分组的刻意折叠可以经受重新渲染、列表更新、搜索、单列表和轨道形态。
- 揭示写入持久化视图存储，因此一次自动展开与手动展开一样跨页面留存；希望当前分组保持关闭的用户，需要在每次导航进入它之后重新折叠一次。
- 启动即选中某个 Session 的侧边栏 golden，现在显示该分组已打开并带有其行，而不再是一个孤零零的折叠组头。
- `deriveGroups` 与 `currentGroupKey` 共用对当前 Session 所属分组的同一次解析，因此染色（`containsCurrent`）与揭示不会对"那是哪个分组"给出不同答案。

## Testing

`workspace-browser.client.spec.tsx` 覆盖：挂载时揭示打开当前 Session 所在分组，且持久化位与 `aria-expanded` 保持一致；刻意的折叠可以经受重新渲染以及同一选择下新的 sessions 快照；在折叠分组内移动选择会再次打开它；在已打开分组内切换选择不写入任何内容；游离 Session 会打开 Ungrouped 桶；新连接 Workspace 的空白 Session；Workspace 基线待定时揭示被推迟、基线落地后完成；以及在另一个分组被揭示的同时，某个折叠分组仍然保留其进行中的行并统计被隐藏的空闲行。`rename-assembly.client.spec.tsx` 无需展开点击即可在组装后的浏览器中抵达当前 Session 的行。

## Related

与[折叠的 Workspace 分组保留运行中的 Session](2026-08-19-collapsed-groups-pin-running-sessions.zh.md)互补——后者让进行中的行穿过折叠仍可抵达，本决定原样保留该行为——并延伸了[Workspace 侧边栏顺序与折叠](2026-08-11-workspace-sidebar-order-and-folding.zh.md)中的折叠规则。

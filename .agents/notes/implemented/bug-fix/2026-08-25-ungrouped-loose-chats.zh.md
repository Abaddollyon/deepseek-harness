# Agent Note: 重新落地「未分组会话」桶作为松散会话的一等归宿

Status: implemented

[English](2026-08-25-ungrouped-loose-chats.md) | 中文

## 问题

已退役的编译产物补丁 `apply-rc6-ungrouped-sessions` 曾让侧边栏的未分组会话桶成为松散会话（loose chat）的一等归宿。0.1.1-rc.2 升级退役编译补丁机制时，该行为被悄然丢失，而第一次修复只恢复了桶的标签；该行为仍然有效且不受本次影响。源码中仍有两个缺陷：

1. **桶的 ＋ 按钮无效。** `WorkspaceBrowser` 的分组 `onCreate` 回调在分组没有 `workspaceId` 时什么都不做，因为唯一的启动路径是 workspace 作用域的 `ctx.workspaces.startSession`。桶本身已作为一等分组渲染（`tree.ts`），缺的只是动作。
2. **无 Workspace 的会话不可用。** `ConversationRoot` 把 `inert` 计算为 `sessionId === undefined || (hero && chipTitle === undefined)`。没有任何 Workspace 入账的真实空白会话没有 chip 标题，因此松散会话会在禁用的编辑器上渲染 Workspace 选择器——刚刚由 ＋ 创建的会话立即失效。

## 决策

- **创建的 seam：在 `WorkspaceBrowserInjected` 上新增 `createLooseSession` 回调**——浏览器其他动作都经由这条 register-inject 面传递（`startSession`、`forkSession`、`open`）。组件以 prop 接收它，与退役补丁的做法一致；不绕过 seam 去触碰具体运行时或 wire client。
- **对外的会话面新增 `create({workspaceId?})`。** `ISessions` 的文档定位就是功能包可对 sessions 领域执行的操作全集，因此在这里暴露创建正是接口头部预留的显式拓宽动作。`SessionRuntime.create` 本已接受省略 `workspaceId`（只是类型面隐藏了它），wire fixture 也一直支持无 Workspace 的 `session.create`——由 Host 分配默认 cwd。跨领域的 `SessionsPort` 保持 `workspaceId` 必填：`connectWorkspace` 的空白会话复用约定属于 workspace 业务，不受影响。测试替身（`TestSessions`）实现该成员，使面变更按设计在编译期形成耦合。
- **＋ 先展开桶再创建**，与 Workspace 行已有的可见性约定一致（`setGroupExpanded` 先于 `startSession`）。
- **inert 谓词为 `sessionId === undefined`。** 证据：退役补丁的原始 hunk（`const inert = sessionId === undefined; /* a session without a workspace is ready (host assigns default cwd) */`）。客户端没有任何状态能区分「有意创建的松散会话」与「Workspace 被删除后的空白会话」——二者都无 Workspace、都保有可用的 cwd，且在首条消息之前，chip 仍可把会话移入某个 Workspace。无会话的冷启动保留 Workspace 触发姿态，因此真正的空白/主视觉状态仍会提示选择 Workspace，且该姿态仍优先于已提起的编辑器 block（选 Workspace 是更靠前的前提）。

## 已考虑的替代方案

**把松散会话创建放到 `IWorkspaces` 上（例如在 `startSession` 旁加 `startLooseSession`）。** 否决：游离于所有 Workspace 之外的会话不属于 Workspace 领域行为，而 `startSession` 省略实参时的语义（继承当前会话的 Workspace，再退到最近活跃的 Workspace，否则清空选择）是有意的目标解析——桶的 ＋ 必须无条件地在所有 Workspace 之外创建。

**仅为 Workspace 被删除的情形保留 `hero && chipTitle === undefined`。** 否决：在客户端可观测的一切状态里，该情形与松散会话无法区分（无属主 Workspace、列表已就绪、cwd 存在或未到）。任何在那里提示的谓词，同样会提示 ＋ 刚刚创建的松散会话。

**经由 `ctx.sessions.binding(id)` 或连接 handle 的 `api.sessions.create` 路由该回调。** 否决：两者都绕过带类型的服务面；binding 解析的是既有会话，wire client 属于运行时内部。

## 后果

- Workspace 被删除的空白会话现在呈现可用的编辑器，而不是 Workspace 提示；它可以作为松散会话继续工作，也可经 chip 移入某个 Workspace。这是有意的「松散会话一等化」语义，而非旧的「经选择器复活」流程的回退。
- 已提起的编辑器 block 对无 Workspace 会话仍然生效：会话存在，因此 block 自己的理由接管惰性姿态。
- 新建的松散会话与近期落地的侧边栏机制无特例地协作：它在桶中恰好列出一次（用户置顶会把它移到「已置顶」分区；折叠分组的进行中保留行不会让它重复出现），导航揭示会为它打开桶，空白提升效果经由通用的当前空白路径把它置顶到 Ungrouped 顺序记账。
- `pnpm run test:coverage` 消费方：`ISessions` 已拓宽，未来任何面漂移都会在编译期弄断 `TestSessions`，而非静默发生。

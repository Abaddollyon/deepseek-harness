# Agent Note: 无 Workspace 聊天选择

Status: implemented

[English](2026-09-15-workspace-free-chat-choice.md) | 中文

## 问题

新 Session 的 Workspace 选择器在目录选择器可用时要求用户选择目录，没有提供明确的不使用 Workspace 的聊天路径。Workspace 列表为空时，选择器还可能直接打开目录流，使用户无法选择无 Workspace 的 Session。同一选择器也被侧边栏的仅添加控件复用，而该控件不应提供无 Workspace 操作。

## 决策

对话选择器从 `ConversationRoot` 接收 `allowNoWorkspace`。无 Session 和空白 New Session 主视觉区路由将该标记设为 true，活动 Session 则设为 false。标记启用时，选择器渲染本地化的 `workspace.menu.noWorkspace` 操作，并通过 `WorkspacePickerInjected` 将其路由到 `UiWorkspaceService.createLooseSession`。该服务调用 `sessions.create({})` 创建并打开独立 Session；它不会重新定位或解除当前显示 Session 的 Workspace。重复请求共享待完成的创建操作，只有最新的导航意图可以打开其结果。对话 owner 在执行此操作前清除待选择的 Workspace 标签。

每次 Workspace 选择都携带取消信号。后续选择、Session 切换或组件销毁会取消前一次选择；选择不使用 Workspace 时，会先取消前一次选择，再请求无 Workspace 的 Session。延迟返回的连接结果不能转移原有草稿或附件，也不能打开过期的目标。Host 仍可能完成未使用的空白 Session 的创建，该 Session 会保持完整。

侧边栏继续以 `addOnly` 使用 `WorkspacePickFlow`，因此只显示组合的目录流。无 Workspace 行会使对话菜单在 Workspace 列表为空或没有目录流占用时仍保持非空；选择器因此等待用户明确选择，不会自动打开目录流。现有目录接纳、忙碌、加载、错误、重试和取消语义保持不变。

无 Workspace 的 Session 继续使用稳定的内部 `UNGROUPED_KEY`，并在界面中显示本地化的**聊天**标签（英文为 **Chats**）。Workspace 删除文案使用相同标签。持久化 key 不变。

## 考虑过的替代方案

重新分配现有 Session 会改变其 Workspace 归属。因此，选择器使用聊天分组采用的同一操作创建独立 Session。侧边栏的仅添加控件仍然只用于目录创建。

## 后果

新聊天用户可以选择 Workspace、通过现有目录流添加 Workspace，或创建不改变现有 Session 的无 Workspace Session。无 Workspace 的对话继续通过现有浏览器本地账本分组和排序，并在侧边栏中显示为**聊天**。

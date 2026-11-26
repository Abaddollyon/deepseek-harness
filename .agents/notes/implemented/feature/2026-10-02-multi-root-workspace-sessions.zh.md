# Agent Note: Session 在创建时记录附加工作区根目录

Status: implemented

[English](2026-10-02-multi-root-workspace-sessions.md) | 中文

## 问题

一项任务常常同时涉及项目目录与相邻目录，例如共享库或文档。Session 的沙箱只允许在其 `cwd` 下写入，因此在其他目录工作需要 `danger-full-access` 或第二个 Session。若每次调用都读取 Workspace 当前的目录列表，一次 Workspace 编辑就会扩大或缩小已运行过的 Session 的权限。

## 决策

[Workspace](../../../../packages/workspace/workspace/README.zh.md) 保存可选的 `additionalPaths`，可通过 Remote `workspace.updatePaths` 命令替换，或由 `workspace.create` 设置。在 Workspace 中执行 `session.create` 时，会把当前列表复制到新 Session 中，作为 seq 0 处可忽略的 `workspace/roots` 事件。`Session.additionalPaths` 读取该事件，`append()` 拒绝该类型，分叉通过种子继承它，进程内的子 agent、workflow 与 Team 子级通过 `childSessionMeta` 获得它。

`sandbox-policy` 通过其按 Session 的可写目录注册来执行该列表（[上游决策](../architecture/2026-10-26-session-writable-directory-effects.zh.md)）。一个 `agent/created` 监听器以 Agent 的上下文为所有者，为每种启动来源（启动、恢复、clear、compact）注册每个 `Session.additionalPaths` 条目，因此授权随 Agent 结束，日志的分离副本不会获得授权。注册前，它通过工作目录服务为该 Agent 提供的文件系统（`working-directory/fs` waterfall）以 `lstat` 检查每个根目录；缺失、不是目录或是符号链接的根目录会被跳过并记录警告。解析出的策略先列出配置的额外目录，再列出已记录的根目录，策略文本只在 `workspace-write` 下列出它们。所有遵循 `additionalWritableRoots` 的执行限制后端（bwrap、Landlock、Seatbelt、fs 围栏、SSH helper）都会授予它们；Windows 文件工具遵循它们，Windows 子进程则忽略它们，与其他额外授权相同（[Windows 范围](../architecture/2026-10-29-windows-file-tool-directory-grants.zh.md)）。`additionalPaths` Session 投影向客户端展示 Session 的列表。

## 备选方案

**`SessionHeader` 字段。** 持久化类型规则把任何 Session header 变更都归为版本升级。它需要 V5 写入方与相邻迁移，并要修改 V4 header 校验、JSONL header 行与查询缓存。

**必需事件。** 不认识必需事件的构建会拒绝整份日志。跳过此事件只会把 Session 限制在 `cwd` 内，而模型可见的策略文本另行作为运行时上下文记录，因此该事件不影响已记录历史的重建。

**每次调用时读取 Workspace 列表。** Workspace 编辑会改变运行中与已归档的 Session，离开 Workspace 的 Session 会失去其根目录。

**在 `sandbox-policy.resolve()` 内解析根目录。** 上游策略只从配置与实时注册读取授权，并拒绝从 Session 历史恢复权限。按 Agent 启动注册可为每个后端保留同一条授权路径。代价是本 fork 在恢复时从已存储事件重新注册，而这正是上游设计有意拒绝的；这些根目录是用户创建时的选择，而非插件的选择。

**注册已不存在的根目录。** 执行限制会在每次调用时以 `SandboxInvalidRootError` 拒绝缺失或为符号链接的额外根目录，因此一个被删除的同级目录就会让该 Session 的所有写入停止。

## 影响

Session 的可写根目录在创建时固定，Workspace 编辑只作用于之后的 Session。列出的目录不再存在时创建会失败；创建后被删除的根目录会在之后的 Agent 启动时被跳过。种子校验与 `validateSessionLog` 拒绝出现在可忽略 seq 0 位置以外的 `workspace/roots` 事件，单次与批量 `append()` 都拒绝它。`workspace/roots` 与上游的 `workspace-root/change`（Host 移动工作目录）是不同的事件。没有此变更的构建打开这类 Session 时会把它限制在 `cwd` 内。远程预设在其 SSH 主机上执行这些根目录，该主机必须拥有全部根目录。聚焦测试覆盖 seq-0 事件及其恢复、继承与批量拒绝、fs 围栏、跳过陈旧根目录的按 Agent 启动注册、Workspace 校验以及客户端文件夹对话框。

# Agent Note: Session 在创建时记录附加工作区根目录

Status: implemented

[English](2026-10-02-multi-root-workspace-sessions.md) | 中文

## 问题

一项任务常常同时涉及项目目录与相邻目录，例如共享库或文档。Session 的沙箱只允许在其 `cwd` 下写入，因此在其他目录工作需要 `danger-full-access` 或第二个 Session。若每次调用都读取 Workspace 当前的目录列表，一次 Workspace 编辑就会扩大或缩小已运行过的 Session 的权限。

## 决策

[Workspace](../../../../packages/workspace/workspace/README.zh.md) 保存可选的 `additionalPaths`，可通过 Remote `workspace.updatePaths` 命令替换，或由 `workspace.create` 设置。在 Workspace 中执行 `session.create` 时，会把当前列表复制到新 Session 中，作为 seq 0 处可忽略的 `workspace/roots` 事件。`Session.additionalPaths` 读取该事件，`append()` 拒绝该类型，分叉通过种子继承它，进程内的子 agent、workflow 与 Team 子级通过 `childSessionMeta` 获得它。

`sandbox-policy` 把该列表解析为 `additionalRoots`，并在策略文本中列出全部根目录。bwrap、Landlock、Seatbelt、fs 围栏与 SSH helper 像对待 `cwd` 根目录一样授予这些根目录。windows-acl runner 拒绝带附加根目录的 workspace-write。`additionalPaths` Session 投影向客户端展示 Session 的列表。

## 备选方案

**`SessionHeader` 字段。** 持久化类型规则把任何 Session header 变更都归为版本升级。它需要 V5 写入方与相邻迁移，并要修改 V4 header 校验、JSONL header 行与查询缓存。

**必需事件。** 不认识必需事件的构建会拒绝整份日志。跳过此事件只会把 Session 限制在 `cwd` 内，而模型可见的策略文本另行作为运行时上下文记录，因此该事件不影响已记录历史的重建。

**每次调用时读取 Workspace 列表。** Workspace 编辑会改变运行中与已归档的 Session，离开 Workspace 的 Session 会失去其根目录。

**通过 Windows ACL runner 授予每个根目录。** 这需要根目录集合的写入 SID 与新的 runner 参数，而本部署无法验证；拒绝可让 Windows 保持失败关闭。

## 影响

Session 的可写根目录在创建时固定，Workspace 编辑只作用于之后的 Session。列出的目录不再存在时创建会失败。没有此变更的构建打开这类 Session 时会把它限制在 `cwd` 内。远程预设在其 SSH 主机上执行这些根目录，该主机必须拥有全部根目录。聚焦测试覆盖 seq-0 事件及其恢复与继承、fs 围栏、策略解析、Workspace 校验以及客户端文件夹对话框。

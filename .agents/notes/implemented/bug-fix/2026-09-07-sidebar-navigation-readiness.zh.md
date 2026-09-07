# Agent Note: 侧边栏导航与就绪状态

Status: implemented

[English](2026-09-07-sidebar-navigation-readiness.md) | 中文

## Problem

会话 feed 失败时看起来像空账户。侧边栏无法从 Environments 返回已选中的会话，而 Activity 显示工作区专属控件，却忽略工作区查询和持久化固定会话。

## Decision

显式工作区打开操作即使没有改变 Session id，也会发布 shell 导航动作。空白导航具有带 Host 身份的 `new-session` location，并且每个意图只清除一次选择，从而允许后续 domain 打开操作离开空白视图。创建失败保持可见，创建操作等待 feed 就绪。返回导航独立于中间的总览访问，记住最近的会话。

侧边栏区分加载、错误、旧行和成功空基线。Workspaces 与 Activity 均有带标签的控件；分组、排序和添加工作区只属于 Workspaces。Activity 使用同一个共享查询，并直接读取现有按 Host 隔离的工作区视图 store 中的固定会话。未挂载 Host 的固定状态也读取同一持久化键，不新增第二套持久化固定状态。固定状态订阅由 effect 管理；shell 释放时也会释放保留的 presentation source。

## Alternatives considered

**仅从 Session id 变化推断导航** 会丢失显式打开当前会话的操作，也无法表示空白会话。

**单独的 Activity 固定状态 store** 重复存储用户意图，导致两个列表不同步。读取现有 source 可保留唯一所有者。

**把不可用的 feed 当作空列表** 会隐藏可恢复的服务失败。空状态文案要求会话和工作区均已就绪。

## Consequences

导航不会发送消息或恢复 goal。Activity provider 使用明确的 Host 身份合并固定状态，并用共享查询过滤自己的行。组件和服务测试覆盖重新打开当前会话、空白导航之后的 domain 打开操作、就绪失败、保留行、创建错误和独立的 Host 固定状态数据源。Activity 占据列表时，原生工作区内容搜索暂停。

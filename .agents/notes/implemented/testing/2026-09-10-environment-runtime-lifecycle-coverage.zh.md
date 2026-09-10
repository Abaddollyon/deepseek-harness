# Agent Note: Environment runtime lifecycle coverage

Status: implemented

[English](2026-09-10-environment-runtime-lifecycle-coverage.md) | 中文

## Problem

环境 runtime 覆盖率必须区分可达的取消、service 撤销、存储上限和 activation 失败，以及违反私有所有权不可能出现的分支。构造不可能的同进程输入不能验证这些义务。

## Decision

[Environment runtime 测试](../../../../packages/client/environment-runtime/tests/) 使用真实实现驱动 acquisition、generation 变化、导航替代、effect disposal 和持久化 JSON。[导航组件测试](../../../../packages/client/ui-environment-navigation/tests/) 验证带 Host 身份的 sidebar mode、overview 渲染和 Activity 清理，不改变产品展示。

以下分支由本地已建立的不变量排除：

- Request parsing 通过字符串替换移除 query 或 fragment，无需数组元素 fallback。escaping、normalization、traversal 和 route authorization 检查保持不变。
- 超过 200 条上限的 presentation map 一定有 oldest key；淘汰直接删除该 key。
- registry entry 在首次 disposal 开始前仍在 map 中；重复 disposal 复用既有 promise，创建失败清理仍检查 entry identity，以处理共享失败的并发 acquisition。
- dirty persistence snapshot 一定有 scheduled timer；flush 会清理 timer、dirty 状态和 handle，disposal 不重复这一步。
- idle projection 已退役远端挂载，因此本地 admission 无需独立的挂载 identity 检查。admission 仍要求 idle phase，因为同步导航订阅者可能将本地请求重定向到远端目标。
- activation error 不会与已挂载 presentation 同时发布；获取失败会在发布 error 状态前移除挂载。
- Session location follower 订阅并读取同一个捕获的 list store。Sessions service 在其生命周期内拥有该 readonly store；snapshot 不会在订阅与通知之间消失。
- composition service 同时只有一个 startup 和一个 active owner；完成与 release 直接清理对应 slot。feature transport 使用 request owner 已绑定的 environment id。
- 两个私有 signal composition 调用方都会提供必需的 lifetime signal，不存在零 signal 结果或 fallback lifetime。

Presentation identity 保留为独立的最终检查：retry 可以在保留 navigation 和已连接 Host generation 的同时替换 UI mount。回调结果要求 projection 为 ready 且 presentation 对象保持不变。断开会保留 mount，但 generation 检查会拒绝过期工作。复制的 observer notification 和失败的 superseded cleanup 可能在取消或撤销后运行，因此保留 settlement 与 identity guard。

## Alternatives considered

覆盖率排除会隐藏可达的 lifecycle 失败。构造空 map、缺失 split 结果或不匹配的注入 carrier id，只会测试私有实现无法产生的值。保留这些分支不能为调用方提供额外保护。

## Consequences

覆盖率验证可观察的 teardown、保留状态、取消和 transport 行为。边界与解析检查保持不变，覆盖率阈值没有修改。未来若允许 composition owner 重叠或零 lifetime signal，必须重新审查对应私有不变量，而不是为不支持的状态添加测试。

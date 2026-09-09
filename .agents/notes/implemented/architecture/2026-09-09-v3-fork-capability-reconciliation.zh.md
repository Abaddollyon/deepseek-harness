# Agent Note: 在权威 V3 运行时上保留 fork 能力

Status: implemented

[English](2026-09-09-v3-fork-capability-reconciliation.md) | 中文

## 问题

fork 能力跨越请求准入、Session 读取和 Host 作用域的 Client 状态。如果在不同的权威 Session 格式旁保留旧实现，回放、token 计量和连接所有权就会出现相互竞争的数据来源。反过来，整文件采用上游版本又会丢失仍属于产品要求的预算、预检准入和 Host 隔离。

## 决策

fork 使用权威 V3 Session 和持久化 API。持久 assistant 输出是 `assistant/message` 或 `assistant/attempt` 内嵌的 stream；实时 `agent/assistant-stream` frame 不会创建第二份持久 chunk 日志。系统提示词属于 `system/message` 历史，而不是请求 header 的载荷。已发布代际保持不可变，并通过[格式迁移规则](2026-08-31-released-session-format-migrations.zh.md)选择相邻后继。消费方使用权威句柄读取；不恢复已退役的原始后缀读取器。

即使系统文本未变化，Chat 也会为 resume 保留可见的请求序列卡片，且在前置加载更早历史后仍保持可见。该卡片标识恢复后的请求序列；它不会再次注入系统提示词，重建的请求仍保留一个有效系统节点。这取代了 [Resume header 不重复系统提示词](../bug-fix/2026-09-03-resume-headers-do-not-repeat-system-prompts.zh.md)的展示决策，但保留其中持久 resume header 不可省略的要求。[request-prompt 投影](../../../../packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts)负责卡片可见性。

预算和精确 prepared-call 计数器仍是循环能力。请求预检发生在路由准备及 system/user/header 提交之后、派生冻结请求之前。重试要求动作声明更新的 replacement generation；有效替换归并系统提示词并开始新的请求序列。提供方错误恢复仍在当前打开的步骤内进行。辅助压缩不能绕过计量：带预算的 agent 会拒绝无法计量的模型摘要。[核心参考](../../../../docs/subsystems/core.zh.md)和[生命周期](../../../../docs/agent-lifecycle.zh.md)负责详细 API 与顺序。

Subagent teardown 仍按子级优先顺序执行，并保留嵌套错误原因，使后代配额分类与重试延迟能传递给调用方和父级通知。在步骤开始前被中断的祖先会保留已持久恢复的任务；待处理输入使 activation 保持驻留，直到显式排空或其他所属操作移除它。[subagent 参考](../../../../packages/subagent/subagent/README.zh.md)负责 teardown 语义，[继续执行回归测试](../../../../packages/subagent/subagent/tests/continuation.spec.ts)覆盖原因保留与中断后输入驻留。

Host 作用域的连接与 Client 状态在使用权威 manifest 和传输 API 的同时保持隔离。`DshClientManifest.defaultRoot` 表达普通根选择中的排除，但不禁止显式选择或依赖纳入；省略时保持默认纳入。[类型化作者示例](../../../../packages/util/package-manifest/README.zh.md)与 [Client modules 规则](../../../../packages/client/modules/README.zh.md)共享该声明，而不是复制 fork 专用的 manifest 类型。

远程上传在读取完整响应体后检查所属 Host generation：仅检查响应头会让已断开 generation 的凭证变得可见。[file-upload 包](../../../../packages/client/file-upload/README.zh.md)负责 carrier 选择与凭证准入。源码环境中的包清单先搜索已安装 manifest，未找到时再使用活跃 Loader 的 ESM resolver；它校验解析出的所属 manifest 身份，并传播模块缺失以外的 resolver 错误。[inventory 包](../../../../packages/llm/plugin-package-inventory-deepseek/README.zh.md)负责此解析，使源码别名无须依赖虚构的安装路径。

导入的评审人路由与上游 Cloudflare 预览发布均限定仓库。它们不能从 fork 请求上游评审人或发布上游预览。独立、托管且无需密钥的 fork CI 工作流保持启用。

## 考虑过的替代方案

**并行保留旧存储和 stream 路径。** 否决，因为两种持久表示会让回放、投递水位和 token 计量依赖于消费方读取哪一种表示。

**整套采用上游实现。** 否决，因为格式的权威性不构成移除独立预算、准入或 Host 隔离要求的理由。这些能力应适配权威 API。

**通过文本并集解决生成参考冲突。** 否决，因为合并后的类型与序号可能不对应任何可执行实现。生成器拥有目录；双语对侧保留生成声明与经评审的正文。

## 后果

fork 保留其能力，但不引入第二个 Session 权威来源。代价是更新每个消费方，并在当前写入器 fixture 旁保留历史 fixture，而不是原地编辑已发布代际。包版本固定和相对 override importer 仍由包管理器负责；手工合并的锁文件能够解析，并不意味着它兼容 frozen install。迁移后的历史日志保留请求含义，但不规定原生写入器的事件布局。[打包 Python 的高级场景](../../../../python/development.zh.md)显式选择 `writer.expected.jsonl` 与 `writer.<ordinal>.expected.jsonl` 作为当前写入器的完整期望输出，而规范 `session*.jsonl` 代际保持不可变。其更新路径先验证角色清单、当前格式头与历史代际，再仅写入写入器期望输出和 `result.json`；严格比较拒绝载荷、格式头与角色漂移。

## 验证

明确的验证义务包括循环预算／预检行为、V3 回放与 SDK 预期、Host 切换和订阅隔离、权威持久化读取、类型化 `defaultRoot` 作者示例，以及 fork 治理的负向 guard。生成新鲜度、类型等价和双语配对检查参考文档，而不是运行时行为。原生 Windows 收容、打包运行时执行、真实提供方调用与浏览器驱动的 Host 切换需要各自所属的验证流程；本 Note 不声称这些流程已经完成。

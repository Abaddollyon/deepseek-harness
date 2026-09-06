# Agent Note: 独立 Host client runtime

Status: implemented

[English](2026-09-06-independent-host-client-runtimes.md) | 中文

## 问题

一个浏览器 shell 可以展示来自多个 Host 的 Session，而这些 Host-local id 可能重叠。复用一棵 Client service tree 会混合 Connection generation、Remote namespace、Session scope、Workspace mirror、功能请求响应与 presentation state。为每个 Host 挂载完整 shell 会重复 renderer 与 Slot declaration；远端环境选中时若仍保留本地 UI registration，则闭包中的 callback 仍会指向错误 Host。

## 决策

`@deepseek-ai/dsh-client-environment-runtime` 为每个已获取 Host 创建新的 Cordis root。Host carrier 提供 unary 与 stream transport；shell 注入的 Connection factory 在可信且 dependency-closed 的 domain roster 激活前创建独立 Connection。显式 transport 只有在声明 `ownsHost: true` 时才获得本地权限，绝不继承 shell 页面的 loopback 权限；未使用显式 override 的 page-root Connection 则保留页面 authority 与继承 transport 的所有权声明。Runtime 发布不可变的环境与 activation identity，公开只允许已注册相对 `/api/` 路由的功能请求 service，并以 Connection generation 的丢失或替换限制请求完成。

Web boot kernel 公开一个由可信 boot manifest 与 memoized module system 支撑的 activator。产品用 `available()` 校验必需 root，推导 domain、presentation 与 suspension closure，并声明已提供的 package face。选中远端环境时会撤下不安全的本地 presentation entry，把选中 runtime 所需的 Cordis service 投影到短生命周期 presentation context，再让这些 entry 使用 shell 中唯一的 renderer、layout、locale、theme 与 Slot registry。返回本地或切换 Host 时，先处置 presentation，再释放 runtime lease；最后一个 lease 会处置 runtime 与 carrier。

本地 environment runtime 在 shell 完整生命周期内拥有 `ctx.environmentNavigation` 及其有界复合 presentation store。Location 与持久化 Store state 使用 `{ environmentId, sessionId }`，而 Slot callback 与 Host API 保留原生 Session id，因此 draft、选中 view 和 detail、scroll anchor 与 sidebar mode 不会冲突。Shell 自有的 `ctx.environmentComposition.withPresentation` coordinator 会打开精确 location，等待目标 presentation 与已连接 generation，再把其 Context 及组合后的调用方、intent、composition signal 传给短生命周期 callback。确认 callback 结果前，它会再次检查 navigation intent、environment、runtime identity、generation 与已挂载 presentation。未启动 composition 时的形式只会公开本地 shell 目标，绝不会把过期远端 presentation 当成本地。活跃 snapshot 会报告 connection state 与最后连接时间；retry 会重连同一个已挂载 runtime。异步切换 presentation 时，Slot registry 会保留前一组 root standard source 与 scope adapter，直到替代者完成安装。`ui-environment-navigation` 在现有 Workspaces 区域内贡献 overview、Activity 铃铛与内容，以及 server footer 操作；撤下它不会拆除 navigation service 或注入该 service 的产品 coordinator。

## 考虑过的替代方案

**使用可替换 transport 的单一 Client root** 被拒绝，因为 Cordis service、event listener、generation 与 apply 自有 cache 会保留前一个 Host 的 identity，并允许迟到工作发布到新选择中。

**每个 Host 使用一套完整应用 shell** 被拒绝，因为这会重复 root Slot declaration、renderer、layout state 与持久导航，而不是让 presentation 只有一个可见 owner。

**在远端 UI 下继续保留本地 presentation** 被拒绝，因为可见 Session 属于另一个 Host 后，本地 callback 与 module-owned resource 仍可能通过本地 `ctx.sessions` 或 `ctx.remote` 发出命令。

## 后果

不同 Host 可以使用相同 Session id，而不共享 runtime、presentation state 或 shell 页面的本地信任；迟到请求也无法跨越 generation 边界。产品 composition 必须维护显式可信 roster，并区分 domain provider、远端 presentation entry、持久 shell service 与不安全本地 registration。Host 切换会 remount presentation plugin，因此需要跨切换保留的状态必须进入 shell-owned 复合 presentation store，而不是 apply-owned module cache。调用方必须把 `withPresentation` callback signal 传入目标操作：取消会阻止尚未开始的 callback，并在 callback 已进入后阻止确认；该 signal 同时为目标请求提供协作式取消边界。Loader lifecycle test 覆盖 withdrawal、restoration、service ownership 与 single-renderer 行为；runtime test 覆盖 context isolation、lease disposal、route authorization、generation fencing、显式 transport 所有权、目标 readiness 与取消 race。

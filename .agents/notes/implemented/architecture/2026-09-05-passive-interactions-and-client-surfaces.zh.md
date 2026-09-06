# Agent Note: 被动交互与命名客户端界面

Status: implemented

[English](2026-09-05-passive-interactions-and-client-surfaces.md) | 中文

## Problem

小型已认证浏览器伴侣需要两类 Host 状态，同时不应继承完整 Web 应用：对已经等待用户处理的交互进行只读观察，以及只包含该伴侣所需 package 的启动图。现有 approval 与 question waterfall 有意持有回答权，而现有 index 渲染器总是发布普通根图。

## Decision

交互层以 `ctx.pendingInteractions` 提供进程本地观察 registry。Approval 与 question 服务只在实际分派 answerer 的区间调用 `begin()` 及其幂等结束能力；snapshot 与排队 delta 公开不透明 identity、kind、可选 agent/session identity、epoch、revision 与时间戳，不公开请求内容或回答方法。Observer 失败、延迟、dispose 与迟到订阅都不能影响 [approval seam](../feature/2026-07-06-approval-seam.zh.md) 与 [Web permission and approval](../feature/2026-07-23-web-permission-and-approval.zh.md) 描述的权威 waterfall。

分发闭包遵循同一所有权边界。交付 approval 或 question 服务的 assembly 也交付 `dsh-pending-interactions`；Python SDK runtime 直接声明该 registry，而不依赖自动安装 peer。通过生成 client map 暴露的公共 discriminator property 带有显式 literal type，使 reflection 与 declaration 生成看到的合同和 TypeScript 消费方一致。

客户端模块层提供 `ctx.clientSurfaces`。注册项命名精确 path、显式 roots 与唯一 root plugin。id、path、root 或必需的 injected dependency 不可用时注册失败；lookup 组成当前传递 `inject` 与动态 `external` 闭包。带有 `dsh.client.defaultRoot: false` 的 package 不进入普通图，除非普通 root 依赖它，因此没有该 metadata 的 package 保持既有 Web 启动行为。

Connection 只接受已注册 surface id 来生成或认证非根 launch URL。浏览器认证只在 registry 选择的精确 pathname 上交换进程 token，并重定向至相同的干净 pathname。Frontend Static 把该已注册 path 识别为 index 入口，并通过 WebServer 的通用 index render variant 传递其 id，使 Client Modules 注入对应图，同时共享其他 index contributor。

## Safety properties

被动 registry 不包含请求正文、approval 决定、question 回答或阻塞式 observer acknowledgement。registry 缺失时保留该 seam 之前的 approval 与 question 行为。Agent 与服务 dispose 会结束记录，而 observer callback 排队执行并隔离失败。

Surface URL 只携带既有 launch token query，绝不接受调用方提供的 return path。未注册 path 仍为静态 miss，未知 surface id 无法生成 URL，注册 dispose 会移除 path discovery，而图闭包排除无关的完整应用 package。Surface 客户端使用普通 Connection Fetch/RPC channel，不需要 Gateway event client。

## Alternatives considered

**把 pending interaction 镜像成持久 session event。** 拒绝，因为未回答 waterfall 状态是进程本地瞬态；持久 replay 可能复活已经死亡的 prompt，或暗示 observer 拥有回答权。

**让伴侣在浏览器中过滤完整 boot graph。** 拒绝，因为被省略的 package 已经被发布并获取，伴侣仍会继承无关启动工作与依赖权限。

**通过 launch token 传递任意 path 或 return URL。** 拒绝，因为 Host registry 已经持有精确可信 path，而调用方控制的 redirect 会扩大认证边界。

**让伴侣使用 Gateway event。** 拒绝，因为被动 snapshot/delta transport 适合已认证 Connection channel，而伴侣不需要完整 session event stream。

## Consequences

Core 现在提供两个可复用 seam，而不是 avatar 专用行为：交互生产方只发布生命周期，任何浏览器伴侣都能注册依赖闭包 surface。代价是新增一个进程本地 registry，并在每次 surface 渲染时组成图；注册方必须准确枚举 roots，分发 root 必须声明被动 registry，必需 package 消失会使 path 无法发现，直到依赖恢复。

聚焦测试固定无 surface 的普通行为、精确 token 交换与干净 redirect、两个独立 surface fixture、依赖闭包、禁止 package 排除、注册冲突与 dispose、交互分派中的 cancellation 与 failure、observer failure containment，以及迟到 observer。

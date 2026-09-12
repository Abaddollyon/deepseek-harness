# Agent Note: MCP Host-owned OAuth connections

Status: implemented

[English](2026-09-06-mcp-host-oauth-connections.md) | 中文

## 问题

[MCP 客户端](2026-07-07-mcp-client-plugin.zh.md)此前在逐 agent 的插件配置里用静态 URL 与标头配置每台服务器。要求 OAuth 的服务器在 harness 中没有归属：复制进 agent 可见配置的静态令牌无法刷新，每个消费方 agent 都持有凭据的副本，也没有登录或撤销路径。这类服务器的端点、客户端参数与令牌是部署方的财产，而不是 agent 配置。

## 决策

**Host 连接所有者。** `packages/mcp/mcp-client/src/connections.ts` 提供 `NativeMcpConnectionsService`（`ctx.nativeMcpConnections`），通过 `./host` 子路径入口（`@deepseek-ai/dsh-mcp-client/host`）在 Host 组合中挂载一次，该入口默认导出这个类：包根是 Agent namespace（函数式）插件，而 Loader 会丢弃函数式插件的其他导出形态，因此包根上的命名类不能作为公开入口被选择；双入口的 tsdown 构建让两个入口共享同一个类身份。本地的 `tsdown.config.ts` 仅作用于 Host：入口对象把 `index` 与 `host` 映射到各自的声明，Client face 的 falsy entry 在任何清理之前跳过，使 Client 构建遍既不能清理也不能重写已完成的 Host 产物；清理窄化为仅顶层 JS 并保留 `lib/types`；打包允许清单显式列出 `lib/index.js` 与 `lib/host.js` 以及窄化的 `lib/connections-*.js` 共享 chunk 模式；根构建选项与 plugins 自动合并，因此该配置不声明任何覆盖。它持有设置支撑的非机密连接配置（`mcp-connections` 命名空间，写入时校验：不含 userinfo 的 HTTPS URL 与记录键所依赖的连接 id 语法）、每个连接一个 OAuth 协议引擎、供人完成登录的原生授权流程注册，以及 agent 侧实例消费的绑定。grant（授权）保存在 `mcp-connections/<connectionId>` 下的原生凭据记录中，只由引擎通过 `ctx.credentials.modifyRecord` 写入；服务本身绝不存储令牌，其状态视图不含令牌。设置变更会实时调和：条目变化在旧引擎退役之前使消费方失效，跨配置变化的授权复用由引擎自己的授权绑定（server、issuer、resource、redirect、client、scopes）隔离，已存储的授权必须与之精确匹配。条目移除会使消费方失效并让引擎与授权流程退役，但在仍有消费方绑定时保持连接可达，因此之后的重新添加能到达同一批消费方，而不是把它们遗弃。

**协议引擎。** `src/oauth.ts` 通过 MCP SDK 的 `auth()` 编排运行每一个 OAuth 步骤——发现、未配置客户端 id 时的 RFC 7591 动态注册、PKCE S256、代码交换、刷新——全部在每个连接一条的串行操作队列内。代码、verifier 与 state 只存在于操作内存中；持久记录只在提交时写入一次，且每次提交都是对操作所观察记录 epoch 的 compare-and-set，因此被撤销、被 dispose 或被取代的操作即使无视自身中止信号也无法复活授权。

**无监听器的交互式授权。** 登录以原生授权流程进行：引擎以通知发出授权 URL，并通过 `secret` 提示索取完整的回调 URL，然后校验已注册的重定向地址、随机 state、已声明时的 issuer，以及单个代码。不创建任何本地回调监听器或端口。

**Host 持有的 fetch。** 引擎的托管 fetch 附加当前 bearer 令牌，只接受已配置的端点，拒绝调用方提供的凭据标头，禁用重定向，并以一次共享的强制刷新加一次重试回应 401，之后才判定失效。SDK 传输不会收到 `authProvider`，因此它既不能通过自己的路径消耗轮换中的刷新令牌，也不能在普通 401 上开启交互式授权。

**权威感知的 agent 桥接。** 插件配置项选择 `transport: host-connection` 并给出 `connectionId`；与其并列的 `url`/`headers` 会在加载时被拒绝，缺少 Host 服务也会明确失败。插件在激活时获取一个绑定，监督器通过它解析每个世代的传输，失效会把活动世代隔离（fence）在 dispose 使用的同一关闭屏障之后：先撤回工具注册，重建时重新求值权威。撤销、scope 变化、配置编辑、重新授权与移除因此立即生效；被撤销或移除的连接不会交出传输，没有新的权威信号也无法复活。传输层中断绝不会以失效的形式出现——它们留在[历史决策记录的普通重连路径](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md)上。

**已提交的变迁携带自身事实。** 引擎每次已提交的变迁都是携带本次提交的记录 epoch 与生效授予 scope 的事件，因此服务根据操作自身的数据判断一次刷新的 scope 变化，而不依赖可能已被另一次提交超越的事后状态读取；提交的 scope 集合与消费方连接时不同的刷新会使消费方失效，来自已退役引擎的变迁则被忽略。本地撤销是唯一在持久化之前报告的变迁：它不携带 epoch，含义是立即的本地拒绝，而不是持久写入确认。不是引擎写入的 `credentials/record-updated`——外部编辑、删除、另一个进程的写入——是作为权威变化使消费方失效的信号；引擎自己的提交已经经由其观察者上报，不再使其反弹失效。

**先本地拒绝，再持久化。** 撤销闩锁本地拒绝、中止进行中的托管请求与正在运行的操作，并在第一次存储 await 之前报告 `revoked`，因此在墓碑写入待定期间——或写入失败之后——到达的请求都会被拒绝，而不是从存储仍持有的记录继续服务；只有显式的重新授权才能解除该闩锁。Host 把被拒绝的凭据键围栏在任何连接状态之外，因此该拒绝比闩锁它的引擎更长寿——配置替换会在同一存储之上构造新引擎——也比连接的移除与重新添加更长寿——即使重新添加的是指向不同端点的同名连接，因为围栏以凭据记录为键而非配置——同样比消费方剪枝更长寿；只有在最近一次闩锁的撤销之后进入并成功提交的新显式授权才能解除围栏，仅仅更早进入的尝试会在其开始处与发布处被拒绝。围栏仅存于内存：Host 重启会遗忘它；当墓碑写入失败时，之后只有持久记录起决定作用——而它可能仍持有授权。墓碑记录必须先提交，然后才有任何有界的远程撤销尝试；写入未获确认会抛出 `STORE`——此时存储状态未知，不进行任何远程尝试，授权服务器侧的令牌可能仍然有效；远程结果如实报告，绝不臆断。`removeGrant()` 直接删除记录，记录更新事件会自行使消费方失效。

公开词汇——条目、解析出的 spec、引擎 seam、状态视图、绑定、撤销——记录在 [MCP Host 连接子系统页](../../../../docs/subsystems/mcp.zh.md)，该页同时承载生成的 `ctx.nativeMcpConnections` 参考。

## 曾考虑的替代方案

**在 agent 侧插件内使用 SDK `authProvider`。** 否决：令牌材料会进入逐 agent 的配置与进程内存，每个 agent 各自刷新并竞争一个轮换中的刷新令牌，也没有单一一方能表示或撤销授权。引擎持有全部令牌流动，正是为了让 SDK 传输绝不需要 `authProvider`。

**本地 loopback 回调监听器。** 否决：它为一次性交接按流程占用端口，扩大 loopback 暴露面。通过既有的 secret 提示通道粘贴完成页 URL，无需任何监听器即可传递同样的授权代码。

**在连接 schema 中于 OAuth 之外提供静态令牌字段。** 否决：固定令牌正是本 seam 要消除的那种不可刷新、被 agent 复制的秘密。只需要静态标头的服务器继续使用旧的 `streamable-http` 传输；Host 托管连接仅支持 OAuth。

**通过凭据存储做跨进程刷新协调。** 当前约定下否决：没有消费方用两个 harness 进程共享一个存储，因此引擎按进程串行化刷新，包 README 记录由此产生的规则——授权的 Host 必须是部署级单例——而不是在没有证据的情况下增加锁协议。

## 测试

`tests/connections.spec.ts` 替换为无 OAuth 的引擎，固定设置调和（新增、变更、移除后仍有绑定的连接保持可达以供重新添加）、跨失效的绑定隔离、受包容的监听器失败、无令牌状态视图、记录变化判定（外部编辑与删除使消费方失效，引擎自己的提交不会）、scope 收窄刷新的失效、撤销次序（闩锁先于存储，拒绝围栏在配置替换、移除与重新添加、剪枝之后仍然存活，拒绝不经存储读取直接报告，只有在最近一次撤销之后进入的授权才能解除围栏，未确认的墓碑之后重启时由持久记录裁决），以及 dispose 的完全停稳。`tests/oauth.spec.ts` 用有界 fetch fixture 驱动真实引擎：发现校验、动态注册、PKCE 与 state 检查、compare-and-set 提交、串行化刷新、401 强制刷新加重试路径，以及撤销结果。`tests/reconnect.spec.ts` 固定权威桥接：失效隔离活动世代，未授权的连接不交出传输并保持等待，重新授权会重建工具。聚焦的包测试套件与包类型检查通过。`mcp-host-entry` artifact 门禁（`scripts/verify-mcp-host-entry.ts` 调用 `tests/host-entry.proof.ts` 的 `verifyMcpHostEntry()`）在真实 Node 进程中运行 `tests/host-loader.fixture.ts`——在 Vitest 源码别名之外、针对构建出的 `lib/`——通过 stock Loader 与 Include、以裸包名从真实 `cordis.yml` 加载两个公开入口：真实文件设置加凭据记录替身、原生授权服务、一个 scoped Agent 与一个 root Agent 配置项；运行中观察到 Host 的消费方台账，Agent 卸载时释放绑定，并在全新上下文中恢复文件设置，全程无 fetch。由于该证明读取构建产物，它不进入默认 Vitest 树：门禁在 CI artifact 车道与 check-all 中等待构建完成，在独立 hygiene 下像 publint 一样假定树已预构建，并在 `lib/` 缺失时给出可执行的失败而不是跳过。`tests/build-config.spec.ts` 以三个纯配置回归检验真实的 `tsdown.config.ts`——它在 `tsconfig.host.json` 中被显式 include，因此始终处于类型检查之下：Host 与缺省 face 解析出入口对象、没有 `plugins` 覆盖、覆盖 manifest 显式打包允许清单的仅顶层 JS `clean`，Client face 解析出 falsy 跳过。打包文件列表仅通过 dry run 验证，不声称已安装包的证明。这是对公开入口的 Node Loader fixture 证明，而不是命名部署 profile 或真实提供方运行的证明。

## 后果

- 令牌绝不进入 agent 侧的配置、日志或状态视图；agent 只持有绑定，每次权威变化都按世代原子地撤回并重建工具。
- Host 托管连接仅支持 OAuth，刷新按进程串行化：授权的 Host 必须是部署级单例，因为两个共享同一凭据存储的 harness 进程可能同时刷新并丢失一次轮换。
- 每次授权都需要人工粘贴回调这一步，没有监听器；尚未授权的连接按设计不给出传输，因此 `failOnStartupError: true` 也会拒绝这种正常的冷启动——这是已记录的配置选择，而不是 OAuth 失败。
- 设置 schema、引擎 seam 与绑定词汇是新的公开面，拥有子系统页与生成的 Cordis 参考；未来的配置界面消费无令牌的状态视图，而不是任何授权载荷。
- 拒绝围栏按设计仅存于内存：当最后一次墓碑写入未获确认而 Host 重启后，由持久记录裁决，它可能仍持有授权——显式重新授权是恢复路径；状态视图报告 Host 自己的拒绝，绝不猜测挂起或失败的存储。

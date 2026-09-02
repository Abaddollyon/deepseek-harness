# Agent Note：Web 载体拥有响应编码与缓存

Status: implemented

[English](2026-08-19-carrier-owned-response-encoding-and-caching.md) | 中文

## Problem

此前 Web 载体让每个 route 直接写入 socket。这样，内容编码协商、响应体大小决策与缓存 header 分散在各个 route 持有者中；日后新增 route 也没有统一答案。

这对浏览器资源尤其危险。像 `?rev=<hash>` 这样的 query 参数本身，并不能证明载体提供的字节具有独立可确认的身份。如果缓存策略把所有此类 URL 都视为 immutable，那么当 route 或部署改变命名约定时，就可能钉住陈旧字节。

因此，载体需要一份由源代码拥有的统一策略，具备受约束的决策缓冲、显式排除项、真实的响应状态，以及能够在不监听端口的情况下驱动 transform 与 socket 事件的测试接缝。

## Decision

**编码与缓存属于载体，而不属于每个 route。** `WebServer` 在分发之前为每个请求安装一份响应补丁（`packages/host/webserver/src/response-policy.ts`），因此具名 route、fallback 席位以及载体生成的 400／404 响应共享同一策略，而无需知道其实现。

**决策缓冲受 `compressMinBytes` 限制。** 该值会被规范化为有限且非负的阈值。低于阈值的响应体会原样刷出；恰好越过阈值时，补丁会把保留的 prefix 与流式发送的 suffix 分开；超大的 `end()` 调用最多保留阈值大小，并把剩余部分交给 transform。阈值为 0 或负数时立即开始压缩。载体不会为了决定是否编码而保存完整的大响应。

**候选资格使用允许清单。** 文本与指定的结构化类型符合条件。已有编码、`Cache-Control: no-transform`、range 响应、HEAD 与无响应体状态、`text/event-stream` 以及已经压缩的媒体保持原样。每个符合条件的响应都会添加 `Vary: Accept-Encoding`，包括最终低于阈值或选择 identity 的响应。

**协商遵循客户端权重。** 客户端给出相同权重时优先 Brotli，再选 gzip；q 值可以改变这个顺序；没有可用的已提供编码时安全回退到 identity。载体不会仅因为无法选择压缩编码就返回 406。

**只有 immutable pathname prefix 才会获得 immutable 缓存指令。** 默认源策略识别 `/assets/`；包括 `?rev=<hash>` 在内的 query 参数不构成依据。载体为 HTML 生成的默认指令是 `no-cache`，其他没有此前缀的响应也会重新验证。handler 提供的 `Cache-Control` 保持权威，因此显式 route 约定不会被静默替换。

**补丁拥有生命周期状态，而原始 I/O 仍由 native 实现执行。** `headersSent` 遵循策略阶段；route 请求逻辑结束时，`finished` 与 `writableEnded` 变为 true；`writableFinished` 则等待实际的 `finish` 事件。`write()` 回调表示载体或 transform 已接受数据；`end()` 回调要等到原始 response 的物理 `end()` 回调。物理 `finish` 之后的 `close` 是正常的终止通知；只有物理 `finish` 之前的 `close` 才视为取消。这个约定无法观测每次 write 的精确 socket 确认时间。

**输入与输出 backpressure 分开处理。** transform 输入可能阻塞，而原始 sink 仍可写；原始 sink 阻塞时，补丁会暂停 transform 的可读侧。只有两个阻塞源都解除后，公共 `drain` 才会按一次欠账派发。`on`、`once`、`addListener`、`off`、`removeListener` 以及清除 listener 的操作会保留载体生命周期 listener 与 route 的注册语义。

**错误与 abort 经过同一个 teardown 控制器。** transform 错误只通过 `onError` 报告一次，所有未完成回调只接收同一个错误一次，未完成的 transform 与 response 按受保护的顺序销毁。客户端 abort 会以取消错误结算回调，但不报告 compressor 错误；两条路径都不会虚构 `finish`。

**源代码与 artifact 配置属于分开的证据平面。** 源代码中的 `WebServer.Config` 默认值为 `compress: true`、`compressMinBytes: 1024`、`brotliQuality: 5`、`gzipLevel: 6`、`immutablePathPrefixes: ['/assets/']` 与 `immutableMaxAgeSeconds: 31536000`。随附 Web 组合的 artifact 则在 `packages/bundle/web-app/cordis.patch.yml` 中单独设置 `compress: true`、`compressMinBytes: 1024`、`brotliQuality: 5`、`gzipLevel: 1`、`immutablePathPrefixes: ['/assets/']` 与 `immutableMaxAgeSeconds: 31536000`。源代码测试不能代替 artifact 已按这些值发出的证明。

**真实组合测试观察 Loader 路径。** `packages/host/webserver/tests/webserver.spec.ts` 通过 vendored Loader 启动临时 `cordis.yml`，使用 WebServer 默认值，并请求 default-policy、小响应、`/assets/` 与 `/plugins/?rev=` route。它断言原始 Brotli 字节、默认阈值以下的 identity、只有配置的 asset prefix 获得 immutable，以及仅有 query 的 plugin URL 使用 `no-cache`。源代码内的 runtime seam 以确定性方式覆盖同样的生命周期迁移，但不声称提供 socket 或 artifact 证据。

## Measured effect

本笔记不作生产流量、字节数或缓存命中率声明。当前可测的本地约定是上述源代码证据：确定性 transform 测试报告变更策略源文件的 statements、branches、functions 与 lines 均为 100%；Loader 测试则是独立的真实组合检查。artifact 值直接读取随附 Web 组合文件，不从源代码默认值推断。

## Alternatives considered

**connect 风格的 `compression` middleware。** 否决，因为此载体没有 middleware 链，middleware 也不会拥有缓存分类，而 `node:zlib` 已经提供所需的两种 transform。

**宽泛的压缩数据库或拒绝清单。** 否决，改用小型允许清单；对不透明或已压缩载荷采取默认拒绝正是需要保留的安全属性。

**在 `frontend-static`、`client-modules` 与 `/api` 中分别压缩。** 否决，因为这会复制阈值、协商、排除与错误逻辑，并让未来新增的 route 没有覆盖。

**从任意文件名 hash 或 query 参数推断 immutable。** 否决，因为载体无法证明另一个 route 的命名约定确实对所服务字节做了 hash。显式 pathname-prefix 配置直接陈述部署约定。

**ETag 或 Last-Modified 校验符。** 暂缓。未来可以降低重新验证响应的响应体成本，但它们不能替代内容编码协商或显式 immutable-prefix 约定。

## Consequences

现在每个响应都获得一份统一的编码与缓存决策。route 持有者必须显式声明例外的 `Cache-Control` 或 `Content-Encoding`；否则，没有此前缀的响应会重新验证，符合条件的大响应会流经所选编码并保持流式传输。

载体需要承担请求期压缩 CPU，并在决策期间保留受约束的 prefix。使用可压缩媒体类型的流式 handler 必须接受预期的阈值行为或调用 `flushHeaders()`；SSE 与其他显式排除的响应类型继续直接写入 socket。

immutable-prefix 是部署约定。若将它指向会原地重写的文件，浏览器可能钉住陈旧字节，因此默认值保持狭窄，query-only revision 也不会扩大该范围。

## Testing

`packages/host/webserver/tests/response-policy.spec.ts` 覆盖协商、q 值、媒体类型资格、缓存分类、所有缓存与排除 header、真实 node:http 终态路径、精确阈值 crossing、超大 write 与 end、回调结算、compressor／sink 分离的 backpressure、drain 记账、header overload、冻结 header、transform 错误、原始 sink 错误，以及压缩前后客户端 abort。其源代码内的 `ResponsePolicyRuntime` seam 提供确定性 transform 与调度；生产 `applyResponsePolicy` 仍是实际使用的入口。

`packages/host/webserver/tests/webserver.spec.ts` 为 WebServer 默认值与原始 HTTP 行为提供真实 vendored-Loader 组合证据。应在允许本地 socket 绑定的环境中运行；静态测试或注入测试不能代替这份 runtime 回执。

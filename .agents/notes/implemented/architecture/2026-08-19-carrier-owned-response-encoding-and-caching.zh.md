# Agent Note: the Web carrier owns response encoding and caching

Status: implemented

[English](2026-08-19-carrier-owned-response-encoding-and-caching.md) | 中文

## Problem

Web GUI 的一次冷加载在 46 个请求中传输 4,587,681 B，其中每一个都是 identity 编码，且没有一个可被复用。

组合中没有任何环节看过 `Accept-Encoding`。shell 文档、带哈希的 `/assets/` chunk、`/plugins` 下的 41 个插件 bundle，以及每一个 `/api` JSON 响应，都由各自持有的 handler 直接写入 socket。对运行中的服务器实测：入口文档 12,842 B、`/assets/vendor-<hash>.js` 744,872 B、`/assets/index-<hash>.js` 442,711 B、一个会话 UI bundle 428,418 B——无论客户端是否发送 `--compressed` 都完全相同。单项占比最大的是客户端插件载荷：41 个 bundle 合计约 3.3 MB。

缓存比缺失更糟，因为它被主动废掉了。`/plugins` route 对每个 bundle 都声明 `cache-control: no-cache`，尽管启动图早已把每个 URL 铸成 `/plugins/<id>/client.js?rev=<字节的 sha1 前缀>`——一个不可能陈旧的 URL，却在每次重新加载时被完整重新下载。其余一切则完全没有指令，等于把决定权交给浏览器的启发式规则。

承载全部服务端到浏览器帧的两条 WebSocket 下行运行时关闭了 `perMessageDeflate`，因此重复的 JSON 封装以原始字节发出。

## Decision

**编码与缓存属于载体，而不属于每个 route。** `WebServer` 在分发之前为每个请求安装一份响应补丁（`packages/host/webserver/src/response-policy.ts`），因此具名 route、fallback 座位以及载体自身的 400／404 响应都获得同样的处理，且无需知道它的存在。另一条路——让 `frontend-static`、`client-modules` 与 `/api` bridge 各自协商——会把一个决策放进三个地方，并让下一个新增的 route 重新发现它。

**该补丁把 `writeHead` 推迟到知道答案为止。** 它缓冲压缩候选，直到响应体在 `compressMinBytes` 之下结束（此时按 handler 自己的响应头原样刷出），或达到阈值（此时写出 `Content-Encoding`、去掉 `Content-Length`，并让其余内容流经一个 `node:zlib` transform）。因此缓冲量受阈值约束，大响应绝不会完整驻留内存。优先级为 brotli、gzip、identity，而客户端自身的 q 值优先于该顺序。

**候选资格是一份媒体类型允许清单。** `text/*` 加上一组具名类型（`application/json`、`application/wasm`、`image/svg+xml`，以及 `+json`／`+xml` 后缀）。已压缩的载荷——PNG、WOFF2、ZIP、视频——因未被列出而被跳过，这也是不需要维护拒绝清单的原因。`text/event-stream` 虽是文本仍被排除：SSE 通道在其生命周期内保持打开，缓冲它以测量阈值会滞留每一个事件。HEAD 请求、无响应体的状态码，以及 handler 已自行编码的响应体同样出局。

**未被提及的 `identity` 取客户端声明过的最低权重。** 这是 `negotiator` 的惯例，而非 RFC 9110 的字面读法：发送 `br;q=0.9, gzip;q=0.8` 的客户端是在要求被编码，把"默认可接受"当作 q=1 会拒绝它刚刚提供的两种编码。什么都不提供的客户端得到 identity，而载体从不返回 406——浏览器无法渲染的资源，比一种它没有排序的编码更糟。

**`Vary: Accept-Encoding` 出现在每个候选响应上，包括最终未压缩的那些**，因为同一个 URL 对不同客户端的答案不同。

**只有携带自身内容哈希的 URL 才会被钉住。** 两个信号：启动图基于 bundle 字节铸造的 `?rev=` 参数，以及位于 `immutablePathPrefixes` 条目之下（默认 `/assets/`），[dist chunk 布局](2026-08-06-web-shell-dist-chunk-layout.md)在那里把每个文件写成 `<name>-<hash><ext>`。两者都意味着改变字节的重新构建同时改变 URL，这正是 `public, max-age=31536000, immutable` 的依据。

**其余一切都重新验证，而这正是 GUI 保持最新的原因。** 使用 `no-cache`——可存储，但未经询问绝不复用——而非 `no-store`，因此未变更的响应仍以廉价的 304 结束。入口文档从不是内容寻址的，因此始终重新验证；正是这份文档声明了当前的 asset 与 bundle URL，所以只要它被重新取回，新构建的带哈希 URL 就是新 URL 并随之被取到。把它钉住会冻结整个应用。

**无论 URL 形态如何，HTML 响应体都不会获得 `immutable`。** SPA fallback 会以 index.html 和状态码 200 回答任意位置的未命中——包括 `/assets/` 之下——因此若没有这条规则，一个输错的带哈希 URL 就会在浏览器中把 shell 钉死在一个构建再也不会产出的地址上。这是整套策略中唯一一处出错后无法从服务端挽回的地方，所以它依据响应的媒体类型而非产生它的 URL 来执行。

**自行声明 `Cache-Control` 的 handler 会保留它**，`/plugins/events` 与 `/api` SSE 通道正是这样保留各自的指令。`/plugins` bundle route 不再声明缓存：它的 URL 是内容寻址的，因此载体钉住 bundle，并让没有哈希的 sourcemap 保持重新验证——这正是该 route 一刀切的 `no-cache` 掩盖掉的正确答案。

**钉住 bundle 要求每个请求方都携带当前哈希**，因为被钉住的答复会被直接复用、根本不会到达宿主。开发期热重载是唯一没有这样做的请求方：它重新拉取启动 URL，依赖该 route 的 `no-cache` 才拿到重建后的字节。`rebuilt` 帧本就带有新哈希，因此浏览器半侧现在会在重新拉取前把那一行图行移到该哈希上（`ClientModuleLoader.revise`），使这次重载成为另一个 URL，也一并解决了旧指令所掩盖的[陈旧图 rev](../../../../packages/client/hmr/README.md)。

**`headersSent` 由补丁自身的阶段回答。** node:http 依据已写入 socket 的字节回答它，而补丁在测量期间有意扣住这些字节。载体的逐请求错误收容用这个问题来在错误状态码与销毁 socket 之间做选择，它需要的答案是 handler 的响应头是否仍可更改。

**下行提供 permessage-deflate，并把 context takeover 保持在 RFC 7692 默认值。** 在一条反复发送同种封装格式的流上，跨帧的滑动窗口贡献了大部分压缩比；代价是每条 socket 每个方向一份 zlib 上下文，承担不起的部署可关闭该扩展。

**每一个阈值、等级与开关都是经过校验的 Config 字段。** 在 `WebServer` 上：`compress`（`true`）、`compressMinBytes`（`1024`）、`brotliQuality`（`5`）、`gzipLevel`（`6`）、`immutablePathPrefixes`（`['/assets/']`）、`immutableMaxAgeSeconds`（`31536000`）。在 `client-connection` 上：`webSocketCompress`（`true`）、`webSocketCompressThreshold`（`1024`）、`webSocketCompressLevel`（`6`）、`webSocketCompressConcurrencyLimit`（`10`）。brotli 质量取 5 而非格式上限，因为 11 面向构建期预压缩；服务端优先顺序、可压缩媒体类型集合与 `rev` 参数名作为协议与格式事实保持固定。

## Measured effect

针对运行中服务器所提供的 dist，以浏览器自身的 `Accept-Encoding: gzip, deflate, br, zstd` 通过新策略重放：

| 资源 | 之前 | 之后（br q5） | 降幅 |
|---|---|---|---|
| 入口文档 | 12,842 B | 1,906 B | 85.2% |
| `/assets/index-<hash>.js` | 442,711 B | 143,764 B | 67.5% |
| `/assets/vendor-<hash>.js` | 744,872 B | 167,732 B | 77.5% |
| `/plugins/…/ui-conversation/client.js` | 428,418 B | 94,166 B | 78.0% |
| 整次冷加载，46 个请求 | 4,587,681 B | 1,051,058 B | 77.1% |

这 46 个响应中，45 个现在是 `immutable`，恰好一个——入口文档——需要重新验证，因此一次重新加载的代价是一个条件请求，加上新构建实际改变的内容。

## Alternatives considered

**`compression` 中间件。** 它正是此处所用"先缓冲后流式"算法的维护良好实现，而仓库策略偏好能删除自有代码的依赖。被否决，因为它是面向 connect 风格中间件链的，而本载体没有中间件链；它只回答了问题的一半（完全不涉及缓存）；并且它会带入 `accepts`、`negotiator`、`bytes`、`compressible`、`mime-db`、`on-headers` 与 `debug`——一条比它替代的约 150 行更庞大的 CJS 依赖尾巴，且位于必须保持 ESM 可解析的源码启动路径上。`node:zlib` 已提供两种编码；只有协商与响应补丁属于我们，且两者都有聚焦测试覆盖。

**只引入 `compressible` 来回答媒体类型问题。** 以更差的性价比因同样理由被否决：为替换一份七条目的允许清单而引入 mime-db，而该清单默认拒绝的行为恰恰是我们想要的属性。

**在 `frontend-static`、`client-modules` 与 `/api` bridge 中分别压缩。** 被否决：这是同一个决策的三份副本，有三次对阈值产生分歧的机会，且对日后新增的 route 没有答案。

**构建期预压缩 dist**（由内容协商提供 `.br`／`.gz` 同名文件）。请求期 CPU 更优，且能在静态部分使用 brotli 质量 11。此处被否决，因为它只覆盖构建产出的文件——不覆盖 `/api` JSON，而审计测得一页 50 条消息的历史为 1,088,001 B——并且它让服务路径依赖一个开发循环并不总会运行的构建步骤。它仍可作为后续补充与本策略并存，而非取而代之。

**仅凭文件名判定内容寻址**（任意位置的 `-<hash>.<ext>` 模式）。被否决，因为它在两个方向上都不安全：它会匹配普通的 `my-component.js`，也会漏掉哈希格式不同的构建。前缀清单陈述部署的实际布局，并在配置错误时明显失败。

**`ETag` 或 `Last-Modified` 校验符。** 暂缓，而非否决。它们会把需重新验证的响应变成无响应体的 304，但唯一频繁重新验证的响应是 12 KB 的入口文档，而计算校验符所依据的事实归 route 所有，不归载体。

## Consequences

冷加载下降 77.1%，重新加载从 4.6 MB 降为一个条件请求。代价是被编码响应上的逐请求 CPU，以及每个响应一份受约束的缓冲。

现在每个 route 的响应都会带上它没有写过的响应头。想要不同缓存的 handler 需显式声明；不想被编码的 handler 需自行设置 `Content-Encoding` 或使用允许清单之外的媒体类型。流式 handler 仍然可用，因为 `text/event-stream` 被排除且 `flushHeaders` 会降级为直通；但日后若有流式 handler 使用可压缩媒体类型且不做上述两者之一，它的首字节会被缓冲至 `compressMinBytes` 才发出。

`immutablePathPrefixes` 是一个有风险的默认值。若某个部署把它指向构建会原地重写文件的目录，就会在每个取过这些文件的浏览器中钉死陈旧字节，且没有任何服务端改动能召回它们。HTML 规则把损害限制在非 HTML 资源上；README 在该字段的文档处陈述了这一约束。

## Testing

`packages/host/webserver/tests/response-policy.spec.ts` 以纯函数方式钉住协商表（服务端优先顺序、客户端 q 值、通配符、无法解析的权重、identity 回退、不返回 406）、媒体类型允许清单与缓存决策，随后在真实 node:http 服务器上断言 HTTP 行为：可解码回原文的 brotli 与 gzip 响应体、客户端不提供编码时的 identity、低于阈值或已压缩载荷不编码、仅在编码时去掉 `Content-Length`、逐块写入的响应体在越过阈值后被编码、SSE 事件在任何 end 之前送达，以及每个 URL 应得的缓存指令。

`packages/host/webserver/tests/webserver.spec.ts` 承担真实 Loader 组合用例：以浏览器的 Accept-Encoding 请求已启动的服务器，入口文档、带哈希的 asset 与带 `?rev=` 的 bundle 均返回 brotli，并在旁边测量对应的 identity 响应，同时逐 URL 断言缓存指令。

`packages/client/connection/tests/websocket-downlink.host.spec.ts` 断言该扩展在随附设置下被协商成功、在部署关闭时不存在，且两种情况下对帧都是透明的。

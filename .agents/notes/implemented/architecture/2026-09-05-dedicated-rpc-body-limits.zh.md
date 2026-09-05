# Agent Note: 专用 RPC channel 请求体上限

Status: implemented

[English](2026-09-05-dedicated-rpc-body-limits.md) | 中文

## 问题

Connection 的共享 HTTP bridge 允许足以承载 Web 应用图片批次的请求体。只传递小型控制消息的专用 JSON channel 会继承 300 MiB 上限，因此功能包若不替换 Connection 已认证的 RPC route 与 JSON envelope 处理，就无法限制自身的内存消耗。

## 决策

`HostConnectionRpc.handle()` 接受可选的第三个参数 `{ maxBodyBytes }`。该值必须是正安全整数，options 对象不得包含其他字段。省略参数时继续使用 `DEFAULT_MAX_REQUEST_BODY_BYTES`，现有注册行为保持不变。

专用 route 把解析后的上限传给现有 node:http bridge。bridge 会拒绝超限的声明式 `Content-Length`，也会在读取没有该 header 的请求体时累计 chunk 大小。两条路径都会返回 413、关闭连接、销毁传入请求，并避免构造 Fetch request、解析 JSON 和分发功能 handler。

## 验证

Host Connection 测试注册一个有界 channel，接受大小恰好等于上限的 chunked JSON envelope，在 handler 分发前拒绝更大的 chunked envelope，并在 route 注册前拒绝畸形 options 对象。现有未配置 channel 的覆盖固定默认调用形式与 effect 持有的释放行为。

## 考虑过的替代方案

**降低共享 `/api` 上限。** 默认上限必须容纳配置的图片总字节数经 base64 膨胀后的体积与 envelope 开销。小型控制 channel 的需求不能降低整个应用的容量。

**让每个功能注册原始 Web route。** 这会让每个小型 channel 重复实现认证、浏览器信任、请求取消、RPC envelope 校验与响应编码。Connection owner 已经拥有正确的物理执行点。

**只检查 `Content-Length`。** Chunked request 可以省略该 header。在 stream 消费期间累计字节，可对两种请求形式执行同一上限。

## 后果

小型专用 channel 可以设置符合自身协议的驻留内存上限，同时保留 Connection 认证与 route 释放。已接受的请求仍会在分发前完整缓冲；共享 `/api` interceptor 继续使用应用级上限，因为其 endpoint owner 要在读取共享请求体后才能确定。

# Agent Note: 客户端 surface 在自身路径启动依赖闭合的启动图

Status: implemented

[English](2026-10-02-client-surfaces.md) | 中文

## 问题

小型的需认证浏览器页面（例如桌面伴侣窗口）需要宿主的模块系统和 Connection，但不需要完整的 Web 应用。index 渲染器总是发布普通根启动图，浏览器认证也只在 `/` 交换启动 token，因此这样的页面要么启动全部客户端插件，要么无法在自身 URL 登录。

## 决策

[Client Modules](../../../../packages/client/modules/README.zh.md) 提供 `ctx.clientSurfaces`。宿主插件在 `ctx.effect` 内注册 `{ id, path, rootPlugin, roots }`；surface 启动图是 client-modules bootstrap 加上 `rootPlugin` 与 `roots` 的 `inject`/`external` 闭包。若根插件属于普通启动图，或所需的 `inject` 包未加载，注册失败；闭包不完整期间该路径不再渲染。`dsh.client.defaultRoot: false` 让仅服务 surface 的包留在普通启动图之外，除非某个普通根包依赖它；未声明该字段的包保持普通 Web 启动行为。

[Frontend Static](../../../../packages/host/frontend-static/README.zh.md) 把已注册路径作为 index 入口提供：其回退的 `auth` 选择器对该路径要求 Peer，因此 WebServer 像对待根路径一样通过 Connection 准入它，渲染时把 surface id 作为 WebServer `IndexRenderContext` 的 `variant` 传入。随后 Client Modules 注入 surface 启动图，并像普通启动图一样按渲染 Peer 的主体投影，其他 index 行保持共享。[Token 插件](../../../../packages/host/authentication-token/README.zh.md)的 `webserver/request` 监听器在根路径与每个已注册 surface 路径上交换启动 token；`BrowserAuth.authorizeIndex` 只在该确切交换路径接受 token，并重定向到同一干净路径。它在请求到达时读取 `ctx.clientSurfaces`，而不依赖 Client Modules。

surface 启动图的行携带所有者的同步配置值，读取自普通组合的刷新结果，不重新计算。其客户端产物与普通启动图是同一批 combo 组合包，因此模块元数据会到达渲染器，闭包包含渲染器时，由它安装样式表。

## 考虑过的替代方案

**让页面在浏览器中过滤普通启动图。** 被否决，因为被省略的包仍会被公布和获取，其启动工作仍会在伴侣页面中运行。

**由拥有该页面的扩展自行提供 surface 页面。** 被否决，因为启动图、combo 响应与启动 token 交换都私属于 Client Modules 与 Connection；扩展将不得不复制它们。

**随启动 token 接受调用方提供的返回路径。** 被否决，因为调用方控制的重定向会扩大认证边界；已注册路径是唯一的非根交换路径。

## 影响

任何浏览器页面都可以通过现有 Connection cookie 与 RPC 通道，在已注册路径启动最小启动图。surface 启动图在普通启动图变化后（包括仅同步值变化）的首次渲染时组合，其 batch 响应会一直提供，直到下一次普通重组替换该代际。`pluginEvents` 帧携带的是普通启动图，因此 surface 页面在下次加载时才看到新代码与同步值，而不是实时看到。注册必须在 `roots` 中列出每个运行时才发现的包，因为闭包只沿声明的 `inject` 与已加载的 `external` 行展开。

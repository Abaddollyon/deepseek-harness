[English](README.md) | 中文

# @deepseek-ai/dsh-web-search-codex

面向 DSH Web seam 的 Codex CLI 订阅式网页搜索提供程序。通过 `ctx.web` 注册固定的 `codex`，每次请求拥有临时 app-server 进程。

## 身份验证

请使用 `codex login` 登录。DSH 不读取凭据、认证文件或密钥链，也不会执行登录。

## 配置

默认值：`cwd=process.cwd()`、`requestTimeoutMs=60000`、`disposeGraceMs=3000`、`maxResults=8`、`maxPayloadBytes=262144`。可用 `executable` 设置覆盖。使用 `web.searchProvider: codex` 选择。

## 生命周期

每次搜索创建只读且禁止审批的新线程。取消、超时和销毁都会终止完整进程树。
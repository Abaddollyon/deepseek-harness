# Agent Note：pi-ai 订阅 OAuth 使用 DSH 自有的提供方记录

Status: implemented

[English](2026-08-15-pi-ai-subscription-oauth-store.md) | 中文

## 问题

pi-ai 已实现 Codex 与 Anthropic 的 OAuth 协议、token 刷新及提供方原生请求格式，但 dsh-llm-pi-ai 构造每个 Models 集合时都没有凭据存储。因此，除非部署把会过期的 token 作为 apiKeyEnv 提供，openai-codex 路由没有可用认证路径；anthropic 路由也只能使用 API key。sidecar 可以代理两种订阅，但会在进程内适配器已经具备的协议外再增加传输、监管与失败行为。

OAuth 刷新是一次读－改－写事务。普通凭据引用一次只解析一个值，无法阻止两个 Harness 进程从同一份过期快照刷新同一 token。单一共享 JSON map 也会让不同提供方的写入互相覆盖，除非所有提供方共用一个全局提交锁。

## 决定

dsh-llm-pi-ai 在 $DSH_HOME/credentials/pi-ai-v1 下拥有持久化的 pi-ai CredentialStore。每个提供方使用一份以 SHA-256 命名的 JSON 记录，内容包含格式版本、未哈希的提供方 id 及完整 pi-ai 凭据。目录仅允许属主访问，每次替换产生的文件仅允许属主读写。读取凭据前会验证内嵌提供方 id、记录版本、凭据判别字段、必需 token 字段、JSON 安全的提供方扩展、文件类型及 POSIX 权限位。

同一提供方的修改通过进程内 promise 队列及提供方文件锁串行化；该锁覆盖重新读取、pi-ai 刷新回调、验证与原子替换。不同提供方使用不同文件与锁，因此刷新不共享提交点。回调返回 undefined 时保留当前凭据，与 pi-ai 的刷新语义一致；登出使用独立且加锁的 delete 操作。list() 只返回排序后的提供方／类型元数据。

每个 dsh-llm-pi-ai 插件实例拥有一个存储实例，并把它传给所有不可变 Models 快照。settings 变化仍会重建提供方／模型集合，但不会重置凭据。设置 apiKeyEnv 的路由继续使用 Harness API-key 覆盖；未设置的路由由 pi-ai 解析已存储 OAuth。可配置提供方目录包含声明 API key 或 OAuth 的 catalog 提供方，包括 openai-codex 与 anthropic。

交互式登录仍由受信任宿主负责。本包导出 PiAiOAuthCredentialStore，供驱动 pi-ai AuthInteraction 的 Node 宿主使用；LLM 请求与回放能力绝不暴露凭据。

## 考虑过的替代方案

- **只保留 CLIProxyAPI 订阅路由：**仅作为可逆 fallback 保留，因为它会在 pi-ai 已拥有的提供方实现外增加受监管进程及 OpenAI 兼容转换层。
- **把 OAuth 存入通用凭据引用服务：**其 resolve/set/unset API 不提供 pi-ai 刷新所需的跨进程回调事务。
- **使用单一、兼容 pi-ai 的 auth.json map：**不同提供方刷新会需要一个全局锁，并共享同一个丢失更新域。
- **请求时直接复制 Codex 或 Claude CLI 文件：**这些文件有不同所有者与锁协议；导入或登录属于显式的受信任宿主操作。

## 结果

原生订阅路由与代理路由可以在迁移期间共存。路由 id 就是凭据 key，因此别名不会自动共享凭据。存储错误会关闭失败，并使用不含秘密的诊断；格式错误或权限过宽的记录不会被静默替换。共享原子写入器通过 rename 发布完整文件，但不执行 fsync，因此突然断电可能丢失最近一次替换，但不会暴露半写 JSON。当前文件锁工具也会在有限等待后关闭失败，且不会窃取孤儿锁；长时间刷新与显式孤儿锁恢复仍是运维限制。

## 验证

包测试覆盖 CRUD、仅元数据列表、回调返回 undefined、回调失败时保留旧值、同提供方串行化、不同提供方并行、属主专用权限、拒绝放宽权限、畸形 JSON 脱敏、提供方 id 不匹配、OAuth 路由发现、既有 API-key 路由、配置重载、组合、回放、转换、发现与适配器行为。包的 TypeScript 构建在标准 workspace program 下编译凭据存储及其依赖引用。

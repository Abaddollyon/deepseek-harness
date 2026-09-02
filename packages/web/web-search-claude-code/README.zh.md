# @deepseek-ai/dsh-web-search-claude-code

English | [English](README.md)

## 摘要

这是一个 Cordis 插件，通过官方 Claude Agent SDK WebSearch 工具为 ctx.web 注册 claude-code 提供方。每个请求拥有一个临时 SDK 进程，并由 ctx.subprocess 负责清理。

## 配置

使用 searchProvider: claude-code 选择它。默认工作目录为 process.cwd()，超时 60 秒，清理宽限期 3 秒，最多八个来源、四轮和 256 KiB 负载。认证由 Claude Code 管理，DSH 不读取凭据，请使用 claude login 登录。仅启用 WebSearch，使用 dontAsk、不持久化会话，并要求结构化 JSON 输出。

## 生命周期

取消、超时和 fiber 释放都会终止完整的子进程树。测试使用确定性的 SDK 消息回放，不执行网络搜索。

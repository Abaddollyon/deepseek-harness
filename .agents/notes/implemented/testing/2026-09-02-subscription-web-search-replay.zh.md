# Agent Note: 订阅式网页搜索回放

Status: implemented

[English](2026-09-02-subscription-web-search-replay.md) | 中文

## 问题

Codex 与 Claude Code 网页搜索依赖已认证的本地 CLI。浏览器与 ACP 覆盖必须在不读取凭据、不访问网络的前提下执行真实提供方代码，也不能让缺失 CLI 导致轮次挂起。

## 决策

Codex fixture 是确定性的 stdio app-server，回放该包的 JSON-RPC 生命周期。Claude Code fixture 是脚本化 Agent SDK query：先调用提供方的受管进程回调，再产出一条原始 WebSearch 消息和一条结构化结果。Web scaffold 仅通过测试自有 profile patch 选择 `codex` 或 `claude-code`，并在已发布树稳定后注册真实提供方；产品 bundle 保持不变。

## 考虑过的替代方案

使用真实 CLI 或提供商凭据会使测试不确定，并违反无密钥回放要求；把提供商行加入产品 bundle 则会测试错误的组合边界。

## 影响

成功断言覆盖答案文本、规范化来源、截断元数据、WebSearchResultView 卡片以及不存在存活的受管子进程。独立的无密钥轮次让可执行文件解析在本地失败，并在有界超时内断言可操作的 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 工具错误。ACP 所属的期望快照复用相同提供方 fixture，且不含凭据、网络数据或机器路径。来源日期是固定的合成值（2001-01-01T00:00:00Z 至 2001-01-06T00:00:00Z），绝非当前时间戳。

## 测试

运行 `pnpm run test:web:refresh -- apps/web/tests/web-search-round.e2e.ts` 刷新浏览器 ARIA golden，并运行 `pnpm run test:expected:refresh -- apps/cli/tests/profiles/acp/tests/subscription-search.expected.e2e.ts` 刷新 ACP fixture 快照；普通模式始终是无密钥回放。

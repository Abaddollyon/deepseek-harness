# Agent Note: Subscription web-search provider contract

Status: proposed

## Problem
订阅式 CLI 需要网页搜索，同时不能修改主机接线或读取凭据。

## Proposal
每个提供程序都是独立 Cordis 插件，通过 `ctx.web.registerSearchProvider` 注册，使用固定 ID，并为每次请求创建受管理进程。

## Alternatives considered
拒绝主机接线、回退链、共享进程和凭据检查。

## Acceptance criteria
Codex 使用窄化 app-server 协议，规范化 WebSearchResult，分类错误并清理进程树。

## Risks
CLI 协议变化可能需要更新回放；认证错误必须可操作且不能泄露机密。
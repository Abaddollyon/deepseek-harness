# Agent Note：有界 JSONL 会话列表

Status: implemented

[English](2026-08-25-session-list-load-performance.md) | 中文

## Problem

JSONL 会话列表会按顺序读取项目和会话目录，因此大型根目录必须依次等待每个 header 探测。

## Decision

默认 `listConcurrency` 为 32。`JsonlSessionPersistence` 通过已验证的并发上限执行冷根编码验证和 `listArtifacts` 目录/header 探测，同时保留发现顺序、重复 id 拒绝、取消和最早发现顺序错误语义。取消会阻止 worker 领取更多探测；普通失败仍会完成有界遍历，再抛出顺序最早的错误。

## Alternatives considered

**使用无界 Promise 扇出。** 拒绝，因为部署根目录可能包含大量会话，无界文件系统压力不安全。

**按完成顺序返回。** 拒绝，因为调用方依赖确定性发现顺序和最早顺序错误。

## Verification

`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` 覆盖 158 个 JSONL 测试，包括不同的并发错误、证明公开 `listConcurrency` 上限会停止后续探测的冷既有根取消、该中止验证尝试后的成功重试、完整结果和持久化 API 转发。

## Consequences

部署可以使用 listConcurrency 调整文件系统压力，同时调用方获得确定性完整结果。

# Agent Note：分离历史冷路径尾部解码

状态：已实现

[English](2026-09-03-session-history-cold-tail.md) | 中文

## Problem

分离 follow 以前会在发送首个快照前恢复所有事件，导致 zstd 解码和投影折叠阻塞主循环。

## Decision

分离 follow 使用绑定身份的缓存检查点，只解码覆盖请求水印的 zstd 尾部帧。historyTail 是可选功能；纯 JSONL、种子谱系、缺少缓存和没有帧索引的后端继续使用完整读取回退。SESSION_FORMAT_VERSION 和 wire 契约不变。

## Consequences

冷首帧工作量随尾部规模增长，过期或缺失检查点仍然安全。正常扫描器和协调器验证继续作为权威。

## Alternatives considered

旁路索引会增加持久化格式和迁移负担；反向扫描现有完整帧可以避免这种变化。完整恢复仍是兼容回退。

## Testing

可选基准生成跨 30 帧的 3,000 个事件（逻辑 JSON 超过 30 MB），将首个尾部页面与完整恢复结果比较，并限制事件循环延迟。
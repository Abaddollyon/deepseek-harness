# Agent Note: 更窄的沙箱请求无需审批并受限运行

Status: implemented

[English](2026-10-02-sandbox-narrower-mode.md) | 中文

## 问题

被委派的 agent 可能在会话以 `danger-full-access` 运行时传入 `sandbox_permissions: workspace-write`。拒绝该调用会中断工作，而该请求要求的权限比调用已有的权限更少。

## 决策

`approveEscalation` 对严格更窄的请求模式无需审批直接返回，工具在该更窄模式下受限运行这一次调用。重复模式仍返回生效模式，更宽模式仍需审批，不支持的目标仍在执行前失败。工具仍要求参数成对出现。这部分取代了[同模式决策](2026-09-16-sandbox-same-mode.zh.md)和[沙箱决策](2026-07-06-sandbox.zh.md)中对更窄目标的拒绝规则；其约束与逐调用审批决策仍然有效。

## 考虑过的替代方案

**拒绝更窄的请求。** 减少权限的请求不会增加风险，拒绝它只会阻止已获授权的工作。

**忽略请求并以生效模式运行。** 调用会以超出模型请求的权限运行，结果与请求不符。

## 影响

Bash、PowerShell、文件系统和 `run_code` 调用在请求更窄模式时无需审批服务或 agent，并在该模式下受限运行。共享单元测试覆盖每一组更窄模式，bash 和 PowerShell 测试检查执行器在无提示的情况下收到更窄模式。

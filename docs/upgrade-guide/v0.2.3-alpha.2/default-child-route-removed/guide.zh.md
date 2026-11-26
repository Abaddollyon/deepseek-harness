---
kind: upgrade-guide
description: "ctx.subagents.declareDefaultChildRoute() 与 defaultChildRoute() 已移除；每个委派工具行自行配置其子级路由。"
---

# 组合级默认子级路由已移除

[English](guide.md) | 中文

## 变更

在上一个 fork 版本中，名为 `subagent` 的 `@deepseek-ai/dsh-tool-subagent` 行通过 `ctx.subagents.declareDefaultChildRoute(route)` 声明其 `agentOptions`。没有配置路由的其他委派路径用 `ctx.subagents.defaultChildRoute(scope)` 读回该路由，因此 Agent Teams 的 teammate 以 `subagent` 工具的路由启动。一个作用域只能声明一条路由，作用域链上最近的声明生效。

这两个方法均已从 `SubagentRuntime` 移除，任何作用域都不再声明默认子级路由。子级以启动它的工具行的 `agentOptions` 启动；省略的字段沿用提供方的路由默认值和父级的路由。Agent Teams 的 teammate 是普通的 `subagent` 与 `subagent_fork` 子级（见 [Agent Teams 使用子代理](../../v0.2.1-rc.2/agent-team-subagents/guide.zh.md)），因此无需声明即可使用 `subagent` 行的路由。

调用这两个方法之一的插件无法通过类型检查，并在运行时抛出 `TypeError`。依赖第二个委派工具沿用 `subagent` 行路由的部署，会改为以提供方默认值启动该工具的子级。

## 迁移

1. 移除对 `ctx.subagents.declareDefaultChildRoute(...)` 的调用及其返回的清理函数。
2. 把每处 `ctx.subagents.defaultChildRoute(scope)` 读取替换为你的工具所配置的路由。应与 `subagent` 行一致的工具在自己的行中使用相同的 `agentOptions`：

   ```yaml
   - id: tool-subagent
     name: '@deepseek-ai/dsh-tool-subagent'
     config:
       provider: spawn
       agentOptions: { provider: deepseek, model: deepseek-v4-pro }
   - id: my-delegation-tool
     name: '@example/dsh-my-delegation-tool'
     config:
       agentOptions: { provider: deepseek, model: deepseek-v4-pro }
   ```

3. 复用 `subagent` 路由规则的工具从 `@deepseek-ai/dsh-tool-subagent/route-selection` 导入它们（`childRouteDefaultsSchema`、`childRouteAgentOptions`、`assertAllowedModelSelection`），而不是读取已声明的路由。
4. 确认迁移：通过每个委派工具启动一个子级，检查子级首条 assistant 消息上记录的 provider 与 model 是否与该工具行的 `agentOptions` 一致。

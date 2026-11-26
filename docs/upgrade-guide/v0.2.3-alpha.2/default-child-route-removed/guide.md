---
kind: upgrade-guide
description: "ctx.subagents.declareDefaultChildRoute() and defaultChildRoute() are removed; each delegation tool row configures its own child route."
---

# The composition-wide default child route is removed

English | [中文](guide.zh.md)

## Change

In the previous fork release, the `@deepseek-ai/dsh-tool-subagent` row named `subagent` declared its `agentOptions` through `ctx.subagents.declareDefaultChildRoute(route)`. Other delegation paths without a configured route read it back with `ctx.subagents.defaultChildRoute(scope)`, so Agent Teams teammates started on the `subagent` tool's route. One scope could declare one route, and the nearest declaration on the scope chain won.

Both methods are removed from `SubagentRuntime`, and no scope declares a default child route. A child starts on the `agentOptions` of the tool row that starts it; omitted fields follow the provider's route defaults and the parent's route. Agent Teams teammates are ordinary `subagent` and `subagent_fork` children (see [Agent Teams uses subagents](../../v0.2.1-rc.2/agent-team-subagents/guide.md)), so they take the `subagent` row's route without a declaration.

Plugins that call either method fail to typecheck and throw `TypeError` at run time. Deployments that relied on a second delegation tool following the `subagent` row's route start that tool's children on the provider defaults instead.

## Migration

1. Remove calls to `ctx.subagents.declareDefaultChildRoute(...)` and the disposer it returned.
2. Replace each `ctx.subagents.defaultChildRoute(scope)` read with the route your tool is configured with. A tool that should match the `subagent` row takes the same `agentOptions` in its own row:

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

3. A tool that reuses the `subagent` route rules imports them from `@deepseek-ai/dsh-tool-subagent/route-selection` (`childRouteDefaultsSchema`, `childRouteAgentOptions`, `assertAllowedModelSelection`) instead of reading a declared route.
4. Confirm the migration: start one child through each delegation tool and check that the provider and model recorded on the child's first assistant message match that tool row's `agentOptions`.

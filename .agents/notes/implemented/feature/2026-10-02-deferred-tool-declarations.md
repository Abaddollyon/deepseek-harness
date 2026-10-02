# Agent Note: Deferred tool declarations

Status: implemented

English | [中文](2026-10-02-deferred-tool-declarations.zh.md)

## Problem

A preset that composes many tools sends every declaration on every request. In a measured PTC session with 158 tools, the generated SDK section was 134k of the 141k-character system prompt, about 33k tokens, and most of it described computer-use, MCP, and memory tools the model rarely calls.

## Decision

`dsh-tools` lists deferred tools by name only. The `defer` config field (`include` and `exclude` whole-name patterns with `*`) sets the deployment policy, `ToolRuntime.deferAs()` shadows it for one scope chain, and the `tool-presentation` preset row exposes it as `defer`. A tool that sets `deferLoading` is deferred unless excluded. Without a policy nothing else changes.

While a scope defers a visible tool, the registry inserts the reserved `tool_search` lookup next to `run_code`. Deferred tools stay registered and callable:

- In PTC mode they leave `ToolArgsMap` and `ToolOutputMap`. A `## More tools` index follows the SDK block with one line per tool, or one line of member names for a namespaced family of more than eight. `tool_search` inside a program returns declarations in the SDK's own language, which stay in the history.
- In native mode they leave the declared tool list, and a `tools:deferred` section carries the same name-only index, listing every deferrable tool so activations leave it unchanged. A direct `tool_search` call returns their JSON schemas and activates them for that agent. The agent loop already logs a newly declared tool as a `tool-addition`, so routes with tool updates add it after the cached history and other routes re-declare the list.
- Under `both`, a direct `tool_search` activates tools for the native list only. The SDK keeps listing every deferrable tool by name, so an activation never rewrites the cached SDK section.
- An argument error from a deferred tool carries that tool's declaration.

Activations live in the registry per agent. On `agent/created` the registry seeds an agent's activations from the tools its last logged request header declared, because that header already records what the model was offered.

## Alternatives considered

**A new Session event for activations.** It would also survive an activation lost between the tool result and the next request header, but it adds a persisted type, a projection, and its compatibility record for a case the model recovers from by searching again.

**Re-render the SDK with looked-up tools.** Adding declarations to the system prompt after a lookup invalidates the cached prefix on every lookup; leaving them in the tool result keeps the prompt stable.

**Defer by default.** Changing what every deployment sends would surprise existing presets; the default policy defers only tools that already ask for it with `deferLoading`.

## Consequences

The measured session drops to about 56k characters (about 15.7k tokens) with computer-use, MCP, most memory, job, and team-task tools deferred, and to about 46k characters (about 11.6k tokens) when the large memory query tool is deferred as well; the index costs about 4-5k characters. A model must spend one lookup before calling a deferred tool, and a crash between activation and the next request header forgets that activation. Unit tests cover the policy, index, lookup, activation, and argument errors; agent-loop tests cover the recorded addition and a persisted resume.

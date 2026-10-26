---
kind: upgrade-guide
description: "MCP browser providers start a later Session's server at its first browser call instead of during Session creation or resume."
---

# MCP browser servers start on first use

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` and `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` accept `serverStart` and default it to `first-use`. Previously each live Session started its own MCP server process while it was created or resumed.

With `first-use`, the first Session of a provider activation starts its server during activation and records the server's startup replies. Later Sessions declare the recorded tools, instructions, and resource servers without a process, and each starts its own server and browser at its first browser tool or resource call. That call waits for the server to start. A later Session whose server fails to start, or does not answer the replayed startup requests within the tool-call timeout, fails that call and stays disconnected instead of failing creation or resume. A server whose startup exchange cannot be replayed makes every later Session start its server during activation again, with one warning in the Host log. Each Session still gets its own server and browser.

Operators who mount either provider observe the later process start and the moved startup failure. Servers whose negotiation, initialization, or tool list depends on the Session directory, and servers that exit on the protocol probe sent before initialization, need the previous behavior.

## Migration

1. To keep the previous behavior, set `serverStart: activation` in the provider's `cordis.yml` entry:

   ```yaml
   - name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
     config:
       mode: launch
       serverStart: activation
   ```

2. To keep the default, make sure the first browser call of a Session tolerates the server start time, and that `toolCallTimeoutMs`, when set, covers that start.
3. Confirm the setting: with `first-use`, creating two Sessions starts one server process, and the second Session's first browser call starts another; with `activation`, each Session creation starts one.

---
kind: upgrade-guide
description: "MCP 浏览器提供方在之后 Session 的首次浏览器调用时启动其服务器，而不是在创建或恢复 Session 期间启动。"
---

# MCP 浏览器服务器在首次使用时启动

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 与 `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` 接受 `serverStart`，默认值为 `first-use`。此前每个活动 Session 在创建或恢复时启动自己的 MCP 服务器进程。

使用 `first-use` 时，提供方本次激活的首个 Session 在激活期间启动其服务器，并记录服务器的启动响应。之后的 Session 无需进程即可声明已记录的工具、指导与资源服务器，并各自在首次浏览器工具或资源调用时启动自己的服务器和浏览器。该调用等待服务器启动。若之后某个 Session 的服务器启动失败，或未在工具调用超时内应答重放的启动请求，该调用失败且 Session 保持断开，而不是让创建或恢复失败。若服务器的启动交换无法重放，之后的每个 Session 重新在激活期间启动其服务器，Host 日志记录一条警告。每个 Session 仍拥有自己的服务器和浏览器。

挂载任一提供方的运维人员会观察到进程启动推迟以及启动失败位置的变化。协商、初始化或工具列表依赖 Session 目录的服务器，以及收到初始化前协议探测即退出的服务器，需要原有行为。

## 迁移

1. 若要保留原有行为，在提供方的 `cordis.yml` 条目中设置 `serverStart: activation`：

   ```yaml
   - name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
     config:
       mode: launch
       serverStart: activation
   ```

2. 若保留默认值，请确认 Session 的首次浏览器调用能容忍服务器启动时间，且设置了 `toolCallTimeoutMs` 时其值涵盖该启动时间。
3. 确认设置生效：使用 `first-use` 时，创建两个 Session 只启动一个服务器进程，第二个 Session 的首次浏览器调用再启动一个；使用 `activation` 时，每次创建 Session 都启动一个。

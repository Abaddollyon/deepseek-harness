/** Caller-wrapped connection transports keep the plugin's lifecycle and tool behavior. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Transport } from '@deepseek-ai/dsh-mcp-client'

const fixture = fileURLToPath(new URL('./fixtures/negotiation-lifecycle.mjs', import.meta.url))

async function registry(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

it('connects through the wrapper around the configured stdio transport and closes it on disposal', async () => {
  const ctx = await registry()
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-wrapper-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const events = join(root, 'events.jsonl')
  const release = join(root, 'release')
  await writeFile(events, '')
  await writeFile(release, '')
  const opened: Transport[] = []
  const plugin = McpClient.withTransportWrapper((open) => {
    const transport = open()
    opened.push(transport)
    return transport
  })
  expect(plugin).toMatchObject({ name: McpClient.name, inject: McpClient.inject, Config: McpClient.Config })
  const fiber = await ctx.plugin(plugin, McpClient.Config({
    transport: 'stdio', serverName: 'wrapped', command: process.execPath, args: [fixture, events, release],
    failOnStartupError: true, reconnect: { enabled: false },
  }))
  expect(opened).toHaveLength(1)
  expect(opened[0]).toBeInstanceOf(StdioClientTransport)
  await fiber.dispose()
  const pids = (await readFile(events, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; pid: number })
    .filter(item => item.event === 'start').map(item => item.pid)
  expect(pids.length).toBeGreaterThan(0)
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
})

it('registers and calls tools through a wrapper transport that replaces the configured one', async () => {
  const ctx = await registry()
  const server = new McpServer({ name: 'in-memory', version: '1' })
  server.registerTool('echo', { description: 'Echo a word.', inputSchema: z.object({ word: z.string() }) }, async args => ({
    content: [{ type: 'text', text: args.word }],
  }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  onTestFinished(() => serving.close())
  await ctx.plugin(McpClient.withTransportWrapper(() => clientTransport), McpClient.Config({
    transport: 'stdio', serverName: 'memory', command: 'never-started', failOnStartupError: true,
  }))
  expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['mcp__memory__echo'])
  const result = await executeToolFixture(ctx, {
    name: 'mcp__memory__echo', arguments: { word: 'wrapped' }, callId: ToolCallId('echo'), signal: new AbortController().signal,
  })
  expect(result.content).toEqual([{ type: 'text', text: 'wrapped' }])
})

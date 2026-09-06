/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Running HTTP fixture and the request headers it observed. */
export interface HttpMcpFixture {
  url: string
  authorization: Array<string | undefined>
  /** Accepted TCP connections, including clients that have not sent HTTP headers. */
  connectionCount(): number
  close: () => Promise<void>
}

/** Start a local stateless MCP endpoint exposing one `ping` tool. */
export async function startHttpMcpFixture(): Promise<HttpMcpFixture> {
  const authorization: Array<string | undefined> = []
  const sockets = new Set<Socket>()
  const cleanups = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const transport = new StreamableHTTPServerTransport({})
    response.once('close', () => {
      const cleanup = Promise.all([transport.close(), mcp.close()]).then(() => {})
      cleanups.add(cleanup)
      void cleanup.then(() => { cleanups.delete(cleanup) }, () => { /* retained and reported by fixture.close() */ })
    })
    await mcp.connect(transport as Transport)
    await transport.handleRequest(request, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    if (closing !== undefined) socket.destroy()
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    connectionCount: () => sockets.size,
    close: () => {
      if (closing !== undefined) return closing
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      }).then(async () => { await Promise.all(cleanups) })
      // server.close() does not terminate an active SSE stream or a TCP client
      // that has not sent headers. Stop accepting first, then close every owned socket.
      for (const socket of sockets) socket.destroy()
      return closing
    },
  }
}

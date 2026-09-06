import { once } from 'node:events'
import { get, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { startHttpMcpFixture } from './http-fixture.ts'

it('quiesces accepted clients that have not sent HTTP headers', async () => {
  const fixture = await startHttpMcpFixture()
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(fixture.url).port) })
  let closing: Promise<void> | undefined
  try {
    await once(socket, 'connect')
    await expect.poll(() => fixture.connectionCount()).toBe(1)
    let stopped = false
    closing = fixture.close().then(() => { stopped = true })
    await expect.poll(() => stopped, { timeout: 1_000 }).toBe(true)
    expect(fixture.connectionCount()).toBe(0)
  } finally {
    // Fallback also closes the unmodified fixture after the negative control fails.
    socket.destroy()
    await (closing ?? fixture.close())
  }
})

it('closes an active SSE response without waiting for its client to disconnect', async () => {
  const fixture = await startHttpMcpFixture()
  const request = get(fixture.url, { headers: { accept: 'text/event-stream' } })
  let closing: Promise<void> | undefined
  try {
    const [response] = await once(request, 'response') as [IncomingMessage]
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    // Forced server shutdown aborts this deliberately unfinished response.
    response.on('error', () => {})
    const responseClosed = new Promise<void>((resolve) => { response.once('close', () => { resolve() }) })
    let stopped = false
    closing = fixture.close().then(() => { stopped = true })
    await expect.poll(() => stopped, { timeout: 1_000 }).toBe(true)
    await responseClosed
    expect(response.destroyed).toBe(true)
    expect(fixture.connectionCount()).toBe(0)
  } finally {
    request.destroy()
    await (closing ?? fixture.close())
  }
})

it('shares one shutdown promise for concurrent and completed close calls', async () => {
  const fixture = await startHttpMcpFixture()
  const closing = fixture.close()
  expect(fixture.close()).toBe(closing)
  await closing
  expect(fixture.close()).toBe(closing)
  expect(fixture.connectionCount()).toBe(0)
})

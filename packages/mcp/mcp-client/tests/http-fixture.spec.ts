import { once } from 'node:events'
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

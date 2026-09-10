import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { applyResponsePolicy, type ResponsePolicy } from '@deepseek-ai/dsh-host-webserver/src/response-policy.ts'
import { createSyntheticExchange, type ResponseSink } from '../../src/transport/synthetic-http.ts'
import type { TunnelRequestFrame } from '../../src/transport/frames.ts'

const policy: ResponsePolicy = {
  compression: { enabled: true, minBytes: 0, gzipLevel: 6, brotliQuality: 4 },
  cache: { immutablePathPrefixes: [], immutableMaxAgeSeconds: 31_536_000 },
}

function harness(method = 'GET', options: { raw?: boolean; body?: TunnelRequestFrame['body'] } = {}) {
  const events: string[] = []
  const chunks: Uint8Array[] = []
  const responses: { status: number; headers: Record<string, string> }[] = []
  const failures: string[] = []
  const sink: ResponseSink = {
    head(status, headers) { responses.push({ status, headers }); events.push('head') },
    chunk(bytes) { chunks.push(bytes); events.push('chunk') },
    end(payload) {
      if (payload !== undefined) {
        responses.push(payload)
        if (payload.body !== undefined) chunks.push(payload.body)
      }
      events.push('end')
    },
    fail(message) { failures.push(message); events.push('fail') },
  }
  const exchange = createSyntheticExchange({
    t: 'req', id: 1, method, url: '/plugins/??fixture/client.js&rev=123', headers: {}, body: options.body,
  }, sink)
  const req = exchange.req as IncomingMessage
  const res = exchange.res as ServerResponse
  const errors: Error[] = []
  if (!options.raw) applyResponsePolicy(req, res, policy, error => errors.push(error))
  return { exchange, req, res, events, chunks, responses, failures, errors }
}

/** Drain both the adapter's microtasks and the carrier's Node nextTick callbacks. */
async function settled(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('worker synthetic response with the Web carrier policy', () => {
  it('serves identity JavaScript with merged headers and completes callbacks before finish and close', async () => {
    const { res, events, chunks, responses, failures, errors } = harness()
    const closed = new Promise<void>(resolve => res.once('close', resolve))
    res.setHeader('X-Preview', 'worker')
    res.appendHeader('X-Preview', 'second')
    res.setHeader('X-Remove', 'unused')
    res.removeHeader('X-Remove')
    res.on('finish', () => events.push('finish'))
    res.on('close', () => events.push('close'))
    res.writeHead(200, 'OK', { 'content-type': 'text/javascript', 'cache-control': 'public, immutable' })
    expect(res.headersSent).toBe(true)
    res.write('first;', 'utf8', (error) => { expect(error).toBeUndefined(); events.push('write-callback') })
    res.end('last;', 'utf8', () => events.push('end-callback'))
    expect(res.writableEnded).toBe(true)
    await closed
    expect(Buffer.concat(chunks).toString()).toBe('first;last;')
    expect(responses).toEqual([{
      status: 200,
      headers: {
        'x-preview': 'worker, second', 'content-type': 'text/javascript',
        'cache-control': 'public, immutable', vary: 'Accept-Encoding',
      },
    }])
    expect(events).toEqual(['head', 'chunk', 'chunk', 'end', 'write-callback', 'end-callback', 'finish', 'close'])
    expect(res.writableFinished).toBe(true)
    expect(failures).toEqual([])
    expect(errors).toEqual([])
  })

  it('sends implicit status and flushes headers without duplicating the response head', async () => {
    const { res, responses, events, chunks } = harness()
    res.setHeader('content-type', 'text/plain')
    res.flushHeaders()
    res.flushHeaders()
    res.end(Buffer.from('body'))
    await settled()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ status: 200, headers: { 'content-type': 'text/plain' } })
    expect(events).toEqual(['head', 'chunk', 'end'])
    expect(Buffer.concat(chunks).toString()).toBe('body')
  })

  it('retains one unary response when a handler only ends', async () => {
    const { res, events, responses, chunks } = harness('HEAD')
    res.writeHead(204, ['X-Preview', 'first', 'X-Preview', 'second'])
    res.end(() => events.push('end-callback'))
    await settled()
    expect(events).toEqual(['end', 'end-callback'])
    expect(responses).toEqual([{ status: 204, headers: { 'x-preview': 'first, second', 'cache-control': 'no-cache' } }])
    expect(chunks).toEqual([])
  })

  it('preserves once, listener identity, duplicate removal, and receiver semantics', async () => {
    const { res } = harness()
    const calls: unknown[] = []
    function listener(this: ServerResponse, value: unknown): void { calls.push([this, value]) }
    res.once('probe', listener)
    res.emit('probe', 1)
    res.emit('probe', 2)
    res.once('probe', listener)
    res.removeListener('probe', listener)
    res.emit('probe', 3)
    res.on('probe', listener)
    res.addListener('probe', listener)
    res.off('probe', listener)
    expect(res.listenerCount('probe')).toBe(1)
    expect(res.eventNames()).toContain('probe')
    res.emit('probe', 4)
    res.removeAllListeners('probe')
    expect(res.listenerCount('probe')).toBe(0)
    expect(calls).toEqual([[res, 1], [res, 4]])
    res.removeAllListeners()
    res.end()
    await settled()
    expect(res.writableFinished).toBe(true)
  })

  it('aborts a streaming response once and settles pending callbacks without further frames', async () => {
    const { exchange, res, events, chunks, failures, errors } = harness()
    const callbacks: (Error | null | undefined)[] = []
    res.on('aborted', () => events.push('aborted'))
    res.on('finish', () => events.push('finish'))
    res.on('close', () => events.push('close'))
    res.write('accepted', error => callbacks.push(error))
    exchange.abort()
    exchange.abort()
    res.write('late', error => callbacks.push(error))
    res.end('later', () => events.push('late-end-callback'))
    await settled()
    expect(exchange.aborted).toBe(true)
    expect(res.destroyed).toBe(true)
    expect(events).toEqual(['head', 'chunk', 'aborted', 'close', 'late-end-callback'])
    expect(callbacks).toHaveLength(2)
    expect(callbacks.every(error => error instanceof Error)).toBe(true)
    expect(Buffer.concat(chunks).toString()).toBe('accepted')
    expect(failures).toEqual([])
    expect(errors).toEqual([])
  })

  it('destroys an unfinished exchange once and never reports finish', async () => {
    const { res, events, failures } = harness()
    const failure = new Error('route stopped')
    const callbacks: (Error | null | undefined)[] = []
    res.on('finish', () => events.push('finish'))
    res.on('close', () => events.push('close'))
    res.write('accepted', error => callbacks.push(error))
    res.destroy(failure)
    res.destroy(failure)
    await settled()
    expect(events).toEqual(['head', 'chunk', 'fail', 'close'])
    expect(failures).toHaveLength(1)
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]).toBeInstanceOf(Error)
  })

  it.each(['abort', 'destroy'] as const)('does not send a second terminal frame when %s precedes end completion', async (operation) => {
    const { exchange, res, events, failures } = harness()
    const callbacks: unknown[] = []
    res.on('finish', () => events.push('finish'))
    res.on('close', () => events.push('close'))
    res.end('body', (error?: unknown) => callbacks.push(error))
    if (operation === 'abort') exchange.abort()
    else res.destroy(new Error('stopped before finish'))
    await settled()
    expect(events).toEqual(['end', 'close'])
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]).toBeInstanceOf(Error)
    expect(failures).toEqual([])
  })

  it('ignores cancellation after successful completion', async () => {
    const { exchange, res, events, failures } = harness()
    res.end('body')
    await settled()
    res.destroy()
    exchange.abort()
    expect(exchange.aborted).toBe(false)
    expect(events).toEqual(['end'])
    expect(failures).toEqual([])
  })
})

describe('raw worker response operations consumed by the carrier', () => {
  it('supports native header access and write/end overloads', async () => {
    const { res, chunks, events, responses } = harness('GET', { raw: true })
    res.appendHeader('X-Values', ['a'])
    res.appendHeader('X-Values', ['b', 'c'])
    expect(res.getHeader('X-Values')).toEqual(['a', 'b', 'c'])
    res.writeHead(201)
    res.write('one', () => events.push('write-callback'))
    res.write('two')
    res.end(() => events.push('end-callback'))
    await settled()
    expect(res.writableEnded).toBe(true)
    expect(res.headersSent).toBe(true)
    expect(Buffer.concat(chunks).toString()).toBe('onetwo')
    expect(responses).toEqual([{ status: 201, headers: { 'x-values': 'a, b, c' } }])
    expect(events).toEqual(['head', 'chunk', 'chunk', 'end', 'write-callback', 'end-callback'])
    res.end(() => events.push('repeat-end-callback'))
    expect(res.write('ignored')).toBe(false)
    await settled()
    expect(events.at(-1)).toBe('repeat-end-callback')
  })

  it('accepts encoded final bytes and a callback in the second slot', async () => {
    const { res, chunks, events } = harness('GET', { raw: true })
    res.end('6162', 'hex', () => events.push('end-callback'))
    await settled()
    expect(Buffer.concat(chunks).toString()).toBe('ab')
    expect(events).toEqual(['end', 'end-callback'])
    const second = harness('GET', { raw: true })
    second.res.end('body', () => second.events.push('end-callback'))
    await settled()
    expect(second.events).toEqual(['end', 'end-callback'])
  })

  it('settles raw callbacks on destruction and emits no more bytes', async () => {
    const { res, events, failures } = harness('GET', { raw: true })
    const callbacks: unknown[] = []
    res.write('accepted', error => callbacks.push(error))
    res.destroy()
    res.flushHeaders()
    res.end('ignored', (error?: unknown) => callbacks.push(error))
    expect(res.write('ignored', error => callbacks.push(error))).toBe(false)
    await settled()
    expect(callbacks).toHaveLength(3)
    expect(callbacks.every(error => error instanceof Error)).toBe(true)
    expect(events).toEqual(['head', 'chunk', 'fail'])
    expect(failures).toEqual(['response destroyed for GET /plugins/??fixture/client.js&rev=123'])
  })
})

async function readBody(req: IncomingMessage): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req as AsyncIterable<Uint8Array>) chunks.push(chunk)
  return chunks
}

describe('worker request body cancellation', () => {
  it.each([undefined, new ArrayBuffer(0), new Uint8Array([1, 2]).buffer])('reads an optional byte body', async (body) => {
    const { req } = harness('POST', { body })
    const received = await readBody(req)
    expect(received.map(chunk => [...chunk])).toEqual(body?.byteLength ? [[1, 2]] : [])
  })

  it('stops byte reads when the request is destroyed', async () => {
    const { req, exchange, events } = harness('POST', { body: new Uint8Array([1]).buffer })
    req.destroy()
    expect(exchange.aborted).toBe(true)
    expect(await readBody(req)).toEqual([])
    expect(events).toEqual([])
  })

  it.each(['blob', 'stream'] as const)('skips empty %s chunks and stops after cancellation', async (kind) => {
    const makeStream = (): ReadableStream<Uint8Array<ArrayBuffer>> => new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(new Uint8Array([1]))
        controller.enqueue(new Uint8Array([2]))
        controller.close()
      },
    })
    const blob = new Blob([])
    blob.stream = makeStream
    const { req, exchange } = harness('POST', { body: kind === 'blob' ? blob : makeStream() })
    const iterator = req[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: new Uint8Array([1]), done: false })
    exchange.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('rejects a transferred stream with a non-byte chunk', async () => {
    // Structured-cloned stream chunks cross the worker boundary without TypeScript checking.
    const body = new ReadableStream<unknown>({ start(controller) { controller.enqueue('not bytes'); controller.close() } })
    const { req } = harness('POST', { body: body as ReadableStream<Uint8Array> })
    await expect(readBody(req)).rejects.toThrow('request stream produced a non-Uint8Array chunk')
  })
})

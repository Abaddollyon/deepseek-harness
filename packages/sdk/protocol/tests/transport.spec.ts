import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { JsonRpcLineTransport, JsonRpcResponseError } from '../src/index.ts'

function transportPair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcLineTransport(bToA, aToB)
  const b = new JsonRpcLineTransport(aToB, bToA)
  return { a, b, aToB, bToA }
}

describe('JsonRpcLineTransport', () => {
  it('supports bidirectional requests and notifications over newline-delimited JSON-RPC', async () => {
    const { a, b } = transportPair()
    const notifications: Record<string, unknown>[] = []

    a.onRequest(async (method, params) => {
      expect(method).toBe('echo')
      return { echoed: params }
    })
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    a.start()
    b.start()

    const response = await b.request('echo', { value: 42 })
    expect(response).toEqual({ echoed: { value: 42 } })

    a.notify('session.status', { sessionId: 'main', status: 'idle' })
    a.notify('heartbeat')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(notifications).toEqual([
      { method: 'session.status', params: { sessionId: 'main', status: 'idle' } },
      { method: 'heartbeat', params: {} },
    ])

    a.close()
    b.close()
  })

  it('reports JSON-RPC request errors from the remote peer with their wire code', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new Error('handler boom')
    })
    a.start()
    b.start()

    const failure = await b.request('explode', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ message: 'handler boom', code: -32603, data: undefined })

    a.close()
    b.close()
  })

  it('rejects immediately on a pre-aborted signal without registering pending state', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    await expect(b.request('never-sent', {}, controller.signal)).rejects.toThrow('already gone')
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('abandons a pending request on abort, stringifying a non-Error reason', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    const pending = b.request('never-answered', {}, controller.signal)
    controller.abort('plain-string-reason')
    await expect(pending).rejects.toThrow('JSON-RPC request aborted: plain-string-reason')
    // The abandonment removed the pending entry — nothing is retained for a
    // response that may never come.
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('preserves structured error data from an error response frame', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error-data', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 7, message: 'structured', data: { detail: 'x' } } })}\n`)

    const failure = await pending.then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: 7, message: 'structured', data: { detail: 'x' } })

    b.close()
  })

  it('stringifies non-Error request handler failures', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw 'string boom'
    })
    a.start()
    b.start()

    await expect(b.request('explode-string', {})).rejects.toThrow('string boom')

    a.close()
    b.close()
  })

  it('reports method-not-found when no request handler is installed', async () => {
    const { a, b } = transportPair()
    a.start()
    b.start()

    await expect(b.request('missing', {})).rejects.toThrow('method not found: missing')

    a.close()
    b.close()
  })

  it('normalizes non-object request params and ignores notifications without a handler', async () => {
    const { aToB, bToA, b } = transportPair()
    const seen: Record<string, unknown>[] = []
    b.onRequest(async (method, params) => {
      seen.push({ method, params })
      return { ok: true }
    })
    b.start()

    aToB.write('{"jsonrpc":"2.0","method":"ignored"}\n')
    aToB.write('{"jsonrpc":"2.0","id":7,"method":"array-params","params":[]}\n')
    const chunk = (await once(bToA, 'data'))[0] as Buffer | string

    expect(seen).toEqual([{ method: 'array-params', params: {} }])
    expect(JSON.parse(String(chunk))).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    b.close()
  })

  it('ignores malformed frames and accepts notifications without params', async () => {
    const { aToB, b } = transportPair()
    const notifications: Record<string, unknown>[] = []
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    b.start()
    b.start()

    aToB.write('not json\n')
    aToB.write('\n')
    aToB.write('null\n')
    aToB.write('{"jsonrpc":"2.0","params":{}}\n')
    aToB.write('{"jsonrpc":"2.0","method":"tick"}\n')
    aToB.emit('data', '{"jsonrpc":"2.0","method":"string-chunk"}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([
      { method: 'tick', params: {} },
      { method: 'string-chunk', params: {} },
    ])
    b.close()
  })

  it('reports malformed frames to an opt-in observer without intercepting valid traffic', async () => {
    const { a, b, aToB } = transportPair()
    const malformed: string[] = []
    const notifications: string[] = []
    b.onMalformed((line) => { malformed.push(line) })
    b.onNotification((method) => { notifications.push(method) })
    a.onRequest(async (_method, params) => params)
    b.onRequest(async (_method, params) => params)
    a.start()
    b.start()

    try {
      const invalid = [
        'not json',
        'null',
        '[]',
        '{"jsonrpc":"2.0","params":{}}',
        '{"jsonrpc":"2.0","id":"unknown","result":null}',
      ]
      for (const line of invalid) aToB.write(`${line}\n`)
      a.notify('tick')

      await expect(b.request('echo', { outbound: true })).resolves.toEqual({ outbound: true })
      await expect(a.request('echo', { inbound: true })).resolves.toEqual({ inbound: true })
      expect(malformed).toEqual(invalid)
      expect(notifications).toEqual(['tick'])
    } finally {
      a.close()
      b.close()
    }
  })

  it('preserves multibyte UTF-8 characters split across Buffer chunks', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const notifications: Record<string, unknown>[] = []
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'message', params: { text: '你好' } })}\n`)
    const character = Buffer.from('你')
    const characterStart = frame.indexOf(character)
    expect(characterStart).toBeGreaterThanOrEqual(0)
    input.write(frame.subarray(0, characterStart + 1))
    input.write(frame.subarray(characterStart + 1))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([{ method: 'message', params: { text: '你好' } }])
    transport.close()
  })

  it('flush waits for all earlier output writes', async () => {
    const events: string[] = []
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const label = chunk.length === 0 ? 'barrier' : 'frame'
        events.push(`start:${label}`)
        setTimeout(() => {
          events.push(`finish:${label}`)
          callback()
        }, 5)
      },
    })
    const transport = new JsonRpcLineTransport(new PassThrough(), output)

    transport.notify('tick')
    await transport.flush()

    expect(events).toEqual([
      'start:frame',
      'finish:frame',
      'start:barrier',
      'finish:barrier',
    ])
    transport.close()
  })

  it('reports an output callback failure from flush', async () => {
    const output = {
      write(_chunk: string, callback?: (error?: Error) => void) {
        callback?.(new Error('flush failed'))
        return true
      },
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    await expect(transport.flush()).rejects.toThrow('flush failed')
  })

  it('contains a synchronous flush write failure', async () => {
    const output = {
      write() {
        throw new Error('flush write exploded')
      },
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    await expect(transport.flush()).rejects.toThrow('flush write exploded')
  })

  it('settles an output callback once and treats null as success', async () => {
    let writes = 0
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1
        callback()
        callback(new Error('late callback failure'))
      },
    })
    const transport = new JsonRpcLineTransport(new PassThrough(), output)

    await expect(transport.flush()).resolves.toBeUndefined()
    expect(writes).toBe(1)
    transport.close()

    const nullOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback(null)
      },
    })
    const nullTransport = new JsonRpcLineTransport(new PassThrough(), nullOutput)
    await expect(nullTransport.flush()).resolves.toBeUndefined()
    nullTransport.close()

    const doubleOutput = {
      write(_payload: string, callback?: (error?: Error) => void) {
        callback?.()
        callback?.()
        return true
      },
    }
    const doubleTransport = new JsonRpcLineTransport(new PassThrough(), doubleOutput as never)
    await expect(doubleTransport.flush()).resolves.toBeUndefined()
  })

  it('rejects pending requests when the input closes', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.end()

    await expect(pending).rejects.toThrow('JSON-RPC input closed')
    b.close()
  })

  it('rejects pending requests when the input errors', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.emit('error', new Error('input broke'))

    await expect(pending).rejects.toThrow('input broke')
    b.close()
  })

  it('retains the first input error for later requests, notifications, and flush', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()
    const first = new Error('input broke')
    input.emit('error', first)
    input.emit('error', new Error('later input broke'))
    input.emit('end')

    await expect(transport.request('after-input-error', {})).rejects.toBe(first)
    transport.notify('ignored')
    await expect(transport.flush()).rejects.toBe(first)
    transport.close()

    const nonErrorInput = new PassThrough()
    const nonErrorOutput = new PassThrough()
    const nonErrorTransport = new JsonRpcLineTransport(nonErrorInput, nonErrorOutput)
    nonErrorTransport.start()
    const pending = nonErrorTransport.request('non-error-input', {})
    nonErrorInput.emit('error', 'string input failure')
    await expect(pending).rejects.toThrow('string input failure')
    nonErrorTransport.close()
  })

  it('uses an input error that races a request serialization failure', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()

    const inputFailure = new Error('input raced serialization')
    const sameFailure = {
      toJSON: () => {
        input.emit('error', inputFailure)
        throw inputFailure
      },
    }
    await expect(transport.request('same-failure', sameFailure)).rejects.toBe(inputFailure)
    transport.close()

    const secondInput = new PassThrough()
    const secondOutput = new PassThrough()
    const second = new JsonRpcLineTransport(secondInput, secondOutput)
    second.start()
    const secondInputFailure = new Error('second input failure')
    const serializationFailure = new Error('serialization failed')
    const differentFailure = {
      toJSON: () => {
        secondInput.emit('error', secondInputFailure)
        throw serializationFailure
      },
    }
    await expect(second.request('different-failure', differentFailure)).rejects.toBe(secondInputFailure)
    second.close()
  })

  it('detaches an abort listener after a request resolves', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => ({ ok: true }))
    a.start()
    b.start()
    const controller = new AbortController()

    await expect(b.request('with-signal', {}, controller.signal)).resolves.toEqual({ ok: true })
    controller.abort()
    a.close()
    b.close()
  })

  it('rejects pending requests when the output stream errors', async () => {
    const input = new PassThrough()
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => { callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) })
      },
    })
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()

    const pending = transport.request('never-replies', {})

    await expect(pending).rejects.toMatchObject({ message: 'write EPIPE', code: 'EPIPE' })
    transport.close()
  })

  it('contains a non-Error output event and rejects later operations', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()
    const pending = transport.request('never-replies', {})

    output.emit('error', 'string output failure')

    await expect(pending).rejects.toThrow('string output failure')
    await expect(transport.request('after-output-error', {})).rejects.toThrow('string output failure')
    transport.notify('ignored')
    await expect(transport.flush()).rejects.toThrow('string output failure')
    transport.close()
  })

  it('contains an input notification handler failure', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.onNotification(() => { throw new Error('notification exploded') })
    transport.start()

    input.write('{"jsonrpc":"2.0","method":"explode"}\n')
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(transport.request('after-notification-failure', {})).rejects.toThrow('notification exploded')
    transport.close()
  })

  it('skips a response write after an earlier output failure', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()
    output.emit('error', new Error('output already failed'))
    input.write('{"jsonrpc":"2.0","id":"missing-handler","method":"work"}\n')
    await new Promise<void>(resolve => setImmediate(resolve))
    transport.close()
  })

  it('uses the removeListener fallback when output lacks off', async () => {
    const output = new EventEmitter() as EventEmitter & {
      write: (payload: string, callback?: (error?: Error) => void) => boolean
    }
    Object.defineProperty(output, 'off', { configurable: true, value: undefined })
    const removeListener = vi.spyOn(output, 'removeListener')
    output.write = (_payload, callback) => {
      callback?.()
      return true
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    transport.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(output.listenerCount('error')).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('error', expect.any(Function))

    const noDetachOutput = {
      on: vi.fn(),
      write: () => true,
    }
    const noDetachTransport = new JsonRpcLineTransport(new PassThrough(), noDetachOutput as never)
    noDetachTransport.close()
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  it('rejects new requests after an output stream failure', async () => {
    const input = new PassThrough()
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => { callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) })
      },
    })
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()

    await expect(transport.request('first', {})).rejects.toMatchObject({ message: 'write EPIPE', code: 'EPIPE' })
    await expect(transport.request('after-output-failure', {})).rejects.toMatchObject({ message: 'write EPIPE', code: 'EPIPE' })
    transport.close()
  })

  it('contains a queued output failure when closing before the write settles', async () => {
    const input = new PassThrough()
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => { callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) })
      },
    })
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()

    const pending = transport.request('queued', {})
    transport.close()
    // The callback and the stream's `error` event are separate asynchronous
    // edges. Keep the transport listener through both so the delayed EPIPE
    // cannot become an unhandled EventEmitter error.
    expect(output.listenerCount('error')).toBe(1)

    await expect(pending).rejects.toThrow('JSON-RPC transport closed')
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(output.listenerCount('error')).toBe(0)
  })

  it('contains a delayed inbound handler that settles after close', async () => {
    const input = new PassThrough()
    const writes: string[] = []
    const output = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk))
        callback()
      },
    })
    let release!: () => void
    const handlerReady = new Promise<void>((resolve) => { release = resolve })
    let handlerStarted!: () => void
    const started = new Promise<void>((resolve) => { handlerStarted = resolve })
    const transport = new JsonRpcLineTransport(input, output)
    transport.onRequest(async () => {
      handlerStarted()
      await handlerReady
      return { ok: true }
    })
    transport.start()

    input.write('{"jsonrpc":"2.0","id":"delayed","method":"work"}\n')
    await started
    transport.close()
    release()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(writes).toEqual([])
  })

  it('finishes an inbound response after the input half-closes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let release!: () => void
    const handlerReady = new Promise<void>((resolve) => { release = resolve })
    let handlerStarted!: () => void
    const started = new Promise<void>((resolve) => { handlerStarted = resolve })
    const transport = new JsonRpcLineTransport(input, output)
    transport.onRequest(async () => {
      handlerStarted()
      await handlerReady
      return { ok: true }
    })
    transport.start()

    input.write('{"jsonrpc":"2.0","id":"half-close","method":"work"}\n')
    await started
    const inputEnded = once(input, 'end')
    input.end()
    await inputEnded
    const response = once(output, 'data')
    release()
    const chunks: unknown[] = await response
    const chunk = chunks[0]

    expect(JSON.parse(String(chunk))).toEqual({ jsonrpc: '2.0', id: 'half-close', result: { ok: true } })
    transport.close()
  })

  it('rejects pending requests when the transport closes', async () => {
    const { b } = transportPair()

    const pending = b.request('never-replies', {})
    b.close()

    await expect(pending).rejects.toThrow('JSON-RPC transport closed')
  })

  it('rejects a request when writing the frame throws', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw new Error('write exploded')
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write exploded')
  })

  it('stringifies non-Error write failures', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw 'write string'
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write string')
  })

  it('uses a fallback message for malformed JSON-RPC error responses', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} })}\n`)

    await expect(pending).rejects.toThrow('JSON-RPC error')
    b.close()
  })

  it('ignores responses that do not match a pending request', async () => {
    const { aToB, b } = transportPair()
    b.start()

    aToB.write('{"jsonrpc":"2.0","id":"unknown","result":{"ignored":true}}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    b.close()
  })
})

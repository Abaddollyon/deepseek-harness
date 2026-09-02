/**
 * Behavior of the carrier's response policy: which coding a client's
 * Accept-Encoding earns, which bodies stay verbatim, and which URLs a browser
 * may reuse without asking. The HTTP assertions run against a real node:http
 * server patched by {@link applyResponsePolicy}, so they observe the bytes and
 * fields a browser would.
 */

import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Transform } from 'node:stream'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { cacheControlFor } from '../src/response-cache.ts'
import { createCompressor, isCompressibleMediaType, selectResponseEncoding } from '../src/response-encoding.ts'
import { applyResponsePolicy, applyResponsePolicyWithRuntime, type ResponsePolicy } from '../src/response-policy.ts'

const POLICY: ResponsePolicy = {
  compression: { enabled: true, minBytes: 1024, brotliQuality: 5, gzipLevel: 6 },
  cache: { immutablePathPrefixes: ['/assets/'], immutableMaxAgeSeconds: 31_536_000 },
}

/** A body large enough to clear the threshold and compress well. */
const LARGE_JSON = JSON.stringify({ messages: Array.from({ length: 400 }, (_, at) => ({ id: at, role: 'assistant', text: 'the quick brown fox jumps over the lazy dog' })) })

let server: Server | undefined

afterEach(async () => {
  const running = server
  server = undefined
  if (running !== undefined) await new Promise<void>((resolve) => { running.close(() => { resolve() }) })
})

/** Start a server whose every response carries the policy under test. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  policy: ResponsePolicy = POLICY,
): Promise<number> {
  const running = createServer((req, res) => {
    applyResponsePolicy(req, res, policy, () => {})
    handler(req, res)
  })
  server = running
  await new Promise<void>((resolve) => { running.listen(0, '127.0.0.1', () => { resolve() }) })
  return (running.address() as AddressInfo).port
}

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** Issue one request WITHOUT any implicit header, so Accept-Encoding is exactly what the test states. */
async function raw(
  port: number, path: string, headers: Record<string, string> = {}, method = 'GET',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ port, host: '127.0.0.1', path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Answer every request with one JSON body. */
function jsonHandler(body: string) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }
}

describe('Accept-Encoding negotiation', () => {
  it('prefers brotli, falls back to gzip, and answers identity when the client offers nothing', () => {
    expect(selectResponseEncoding('gzip, deflate, br')).toBe('br')
    expect(selectResponseEncoding('gzip, deflate')).toBe('gzip')
    expect(selectResponseEncoding('deflate')).toBe('identity')
    expect(selectResponseEncoding(undefined)).toBe('identity')
    expect(selectResponseEncoding('')).toBe('identity')
  })

  it('honours the client weights ahead of the server preference', () => {
    expect(selectResponseEncoding('gzip;q=1.0, br;q=0.5')).toBe('gzip')
    expect(selectResponseEncoding('br;q=0.9, gzip;q=0.8')).toBe('br')
    expect(selectResponseEncoding('br;q=0, gzip')).toBe('gzip')
    expect(selectResponseEncoding('*')).toBe('br')
    expect(selectResponseEncoding('*;q=0, gzip')).toBe('gzip')
  })

  it('treats an unparseable weight as a refusal and never answers 406', () => {
    expect(selectResponseEncoding('br;q=nonsense, gzip')).toBe('gzip')
    expect(selectResponseEncoding('identity;q=0')).toBe('identity')
    expect(selectResponseEncoding('*;q=0')).toBe('identity')
    expect(selectResponseEncoding('br;q=2, gzip;q=0.5')).toBe('gzip')
    expect(selectResponseEncoding('br;q=-1, gzip;q=0.5')).toBe('gzip')
  })

  it('ignores empty codings and non-q parameters while parsing repeated q values', () => {
    expect(selectResponseEncoding(', gzip;level;level=fast; q=0.6; q=0.4, br;profile=web;q=0.2'))
      .toBe('gzip')
  })

  it('compresses text and structured text, and skips already-compressed media', () => {
    expect(isCompressibleMediaType('text/html; charset=utf-8')).toBe(true)
    expect(isCompressibleMediaType('application/json')).toBe(true)
    expect(isCompressibleMediaType('image/svg+xml')).toBe(true)
    expect(isCompressibleMediaType('application/vnd.api+json')).toBe(true)
    expect(isCompressibleMediaType('image/png')).toBe(false)
    expect(isCompressibleMediaType('font/woff2')).toBe(false)
    expect(isCompressibleMediaType('application/zip')).toBe(false)
    expect(isCompressibleMediaType('video/mp4')).toBe(false)
    expect(isCompressibleMediaType(undefined)).toBe(false)

    const brotli = createCompressor('br', POLICY.compression)
    const gzip = createCompressor('gzip', POLICY.compression)
    expect(brotli.readable).toBe(true)
    expect(gzip.readable).toBe(true)
    brotli.destroy()
    gzip.destroy()
  })

  it('excludes text/event-stream so an open channel is never held back', () => {
    expect(isCompressibleMediaType('text/event-stream')).toBe(false)
  })
})

describe('cache directives', () => {
  const cache = POLICY.cache

  it('gives content-addressed URLs an immutable lifetime', () => {
    expect(cacheControlFor('/assets/index-CSGf6Qzd.css', 'text/css', cache))
      .toBe('public, max-age=31536000, immutable')
    expect(cacheControlFor('/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=c3a65f7f440a', 'text/javascript', cache))
      .toBe('no-cache')
  })

  it('keeps everything not content-addressed revalidated', () => {
    expect(cacheControlFor('/', 'text/html; charset=utf-8', cache)).toBe('no-cache')
    expect(cacheControlFor('/plugins/@deepseek-ai/dsh-client-modules/client.js', 'text/javascript', cache)).toBe('no-cache')
    expect(cacheControlFor('/plugins/@deepseek-ai/dsh-client-modules/client.js.map', 'application/json', cache)).toBe('no-cache')
    expect(cacheControlFor('/api/session.list', 'application/json', cache)).toBe('no-cache')
  })

  it('never pins an HTML answer, so the SPA fallback cannot freeze the shell under a hashed URL', () => {
    expect(cacheControlFor('/assets/never-built-aaaaaaaa.js', 'text/html; charset=utf-8', cache)).toBe('no-cache')
  })
})

describe('a patched response', () => {
  it('encodes a large body with the coding the client asked for', async () => {
    const port = await serve(jsonHandler(LARGE_JSON))

    const brotli = await raw(port, '/api/session.history', { 'accept-encoding': 'gzip, deflate, br' })
    expect(brotli.headers['content-encoding']).toBe('br')
    expect(brotli.headers.vary).toBe('Accept-Encoding')
    expect(brotliDecompressSync(brotli.body).toString('utf8')).toBe(LARGE_JSON)
    expect(brotli.body.byteLength).toBeLessThan(LARGE_JSON.length / 4)

    const gzip = await raw(port, '/api/session.history', { 'accept-encoding': 'gzip' })
    expect(gzip.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(gzip.body).toString('utf8')).toBe(LARGE_JSON)
    expect(gzip.body.byteLength).toBeLessThan(LARGE_JSON.length / 4)
  })

  it('sends the body verbatim when the client offers no coding, and still varies on it', async () => {
    const port = await serve(jsonHandler(LARGE_JSON))
    const answer = await raw(port, '/api/session.history')
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.headers.vary).toBe('Accept-Encoding')
    expect(answer.body.toString('utf8')).toBe(LARGE_JSON)
  })

  it('leaves a body under the threshold uncompressed', async () => {
    const small = JSON.stringify({ ok: true })
    const port = await serve(jsonHandler(small))
    const answer = await raw(port, '/api/ping', { 'accept-encoding': 'br, gzip' })
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.body.toString('utf8')).toBe(small)
  })

  it('compresses one oversized end call after retaining only the threshold prefix', async () => {
    const body = 'crossing-end-'.repeat(12)
    const port = await serve(jsonHandler(body), {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 16 },
    })
    const answer = await raw(port, '/api/crossing-end', { 'accept-encoding': 'gzip' })

    expect(answer.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(answer.body).toString('utf8')).toBe(body)
  })

  it('continues an active compressor with the body supplied to end', async () => {
    const prefix = 'prefix-crosses-threshold-'
    const suffix = 'suffix-after-compressor-start'
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.write(prefix)
      res.end(suffix)
    }, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: prefix.length - 1 },
    })
    const answer = await raw(port, '/api/active-compressor', { 'accept-encoding': 'br' })

    expect(answer.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(answer.body).toString('utf8')).toBe(prefix + suffix)
  })

  it('leaves an already-compressed payload alone and does not vary on it', async () => {
    const png = Buffer.alloc(64_000, 7)
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png)
    })
    const answer = await raw(port, '/assets/logo-aaaaaaaa.png', { 'accept-encoding': 'br, gzip' })
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.headers.vary).toBeUndefined()
    expect(answer.body.byteLength).toBe(png.byteLength)
  })

  it('leaves a body the handler already encoded alone', async () => {
    const prebuilt = gzipSync(Buffer.from(LARGE_JSON, 'utf8'))
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(prebuilt)
    })
    const answer = await raw(port, '/api/prebuilt', { 'accept-encoding': 'br, gzip' })
    expect(answer.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(answer.body).toString('utf8')).toBe(LARGE_JSON)
  })

  it('does not encode a HEAD answer', async () => {
    const port = await serve(jsonHandler(LARGE_JSON))
    const answer = await raw(port, '/api/session.history', { 'accept-encoding': 'br' }, 'HEAD')
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.body.byteLength).toBe(0)
  })

  it('drops Content-Length when it encodes, and keeps it when it does not', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(LARGE_JSON)),
      })
      res.end(LARGE_JSON)
    })
    const encoded = await raw(port, '/api/session.history', { 'accept-encoding': 'br' })
    expect(encoded.headers['content-length']).toBeUndefined()
    expect(encoded.headers['transfer-encoding']).toBe('chunked')

    const verbatim = await raw(port, '/api/session.history')
    expect(verbatim.headers['content-length']).toBe(String(Buffer.byteLength(LARGE_JSON)))
  })

  it('encodes a body written chunk by chunk once it passes the threshold', async () => {
    const chunk = 'x'.repeat(400)
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      for (let at = 0; at < 20; at += 1) res.write(chunk)
      res.end()
    })
    const answer = await raw(port, '/api/stream', { 'accept-encoding': 'gzip' })
    expect(answer.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(answer.body).toString('utf8')).toBe(chunk.repeat(20))
  })

  it('never withholds an SSE event to measure a threshold', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: first\n\n')
    })
    const firstEvent = await new Promise<string>((resolve) => {
      const req = httpRequest({ port, host: '127.0.0.1', path: '/api/events/mux', headers: { 'accept-encoding': 'br, gzip' } }, (res) => {
        expect(res.headers['content-encoding']).toBeUndefined()
        res.once('data', (data: Buffer) => {
          req.destroy()
          resolve(data.toString('utf8'))
        })
      })
      req.on('error', () => { /* the client-side abort above is the fixture outcome */ })
      req.end()
    })
    expect(firstEvent).toBe('data: first\n\n')
  })

  it('preserves no-transform and range responses without encoding', async () => {
    const port = await serve((req, res) => {
      const path = req.url ?? ''
      const status = path === '/status' ? 206 : 200
      const headers = {
        'content-type': 'application/json',
        ...(path === '/transform' ? { 'cache-control': 'public, no-TRANSFORM' } : {}),
        ...(path === '/header' ? { 'content-range': 'bytes 0-1023/4000' } : {}),
      }
      res.writeHead(status, headers)
      res.end(LARGE_JSON)
    })
    for (const [path, status] of [['/transform', 200], ['/header', 200], ['/status', 206]] as const) {
      const answer = await raw(port, path, { 'accept-encoding': 'br, gzip' })
      expect(answer.status).toBe(status)
      expect(answer.headers['content-encoding']).toBeUndefined()
      expect(answer.body.toString('utf8')).toBe(LARGE_JSON)
    }
    const ranged = await raw(port, '/ordinary', { 'accept-encoding': 'br, gzip', range: 'bytes=0-1023' })
    expect(ranged.headers['content-encoding']).toBeUndefined()
    expect(ranged.body.toString('utf8')).toBe(LARGE_JSON)
  })

  it('attaches the cache directive the URL earns and keeps one the handler stated', async () => {
    const port = await serve((req, res) => {
      const stated = req.url?.startsWith('/stated') === true
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        ...stated ? { 'cache-control': 'private, max-age=60' } : {},
      })
      res.end('export default 1')
    })
    expect((await raw(port, '/assets/index-Dqw48FrP.js')).headers['cache-control'])
      .toBe('public, max-age=31536000, immutable')
    expect((await raw(port, '/plugins/@deepseek-ai/dsh-client-web/client.js?rev=deadbeef1234')).headers['cache-control'])
      .toBe('no-cache')
    expect((await raw(port, '/plugins/@deepseek-ai/dsh-client-web/client.js')).headers['cache-control'])
      .toBe('no-cache')
    expect((await raw(port, '/stated/thing.js')).headers['cache-control'])
      .toBe('private, max-age=60')
  })

  it('leaves the entry document revalidated even when the shell answers a hashed URL', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head></head><body>shell</body></html>')
    })
    expect((await raw(port, '/')).headers['cache-control']).toBe('no-cache')
    expect((await raw(port, '/assets/never-built-aaaaaaaa.js')).headers['cache-control']).toBe('no-cache')
  })

  it('emits nothing but the verbatim body when compression is switched off', async () => {
    const port = await serve(jsonHandler(LARGE_JSON), {
      compression: { ...POLICY.compression, enabled: false },
      cache: POLICY.cache,
    })
    const answer = await raw(port, '/api/session.history', { 'accept-encoding': 'br, gzip' })
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.headers.vary).toBeUndefined()
    expect(answer.body.toString('utf8')).toBe(LARGE_JSON)
  })

  it('carries a status the handler set without writeHead, and skips bodiless statuses', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/gone') {
        res.statusCode = 404
        res.end('missing')
        return
      }
      res.writeHead(204)
      res.end()
    })
    const missing = await raw(port, '/gone', { 'accept-encoding': 'br' })
    expect(missing.status).toBe(404)
    expect(missing.body.toString('utf8')).toBe('missing')
    expect((await raw(port, '/none', { 'accept-encoding': 'br' })).status).toBe(204)
  })

  it('preserves repeated flat headers and exposes writeHead state immediately', async () => {
    let observedStatus: [number, string] | undefined
    const port = await serve((_req, res) => {
      res.writeHead(201, 'Made', [
        'content-type', 'application/json; charset=utf-8',
        'vary', 'Origin',
        'set-cookie', 'a=1',
        'set-cookie', 'b=2',
        'set-cookie', 'c=3',
        'warning', '199 one',
        'warning', '299 two',
        'warning', '399 three',
      ])
      observedStatus = [res.statusCode, res.statusMessage]
      res.end(LARGE_JSON)
    })
    const answer = await raw(port, '/api/session.history', { 'accept-encoding': 'br' })
    expect(observedStatus).toEqual([201, 'Made'])
    expect(answer.status).toBe(201)
    expect(answer.headers.vary).toBe('Origin, Accept-Encoding')
    expect(answer.headers['set-cookie']).toEqual(['a=1', 'b=2', 'c=3'])
    expect(String(answer.headers.warning)).toContain('199 one')
    expect(String(answer.headers.warning)).toContain('299 two')
    expect(String(answer.headers.warning)).toContain('399 three')
    expect(brotliDecompressSync(answer.body).toString('utf8')).toBe(LARGE_JSON)
  })

  it('degrades to passthrough when the handler flushes headers before its body', async () => {
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.flushHeaders()
      res.end(LARGE_JSON)
    })
    const answer = await raw(port, '/slow', { 'accept-encoding': 'br' })
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.headers['cache-control']).toBe('no-cache')
    expect(answer.body.toString('utf8')).toBe(LARGE_JSON)
  })

  it('reports the head as sent once the handler committed it, so error containment still works', async () => {
    let sentBeforeBody: boolean | undefined
    let sentAfterHead: boolean | undefined
    const port = await serve((_req, res) => {
      sentBeforeBody = res.headersSent
      res.writeHead(200, { 'content-type': 'application/json' })
      sentAfterHead = res.headersSent
      res.end(LARGE_JSON)
    })
    await raw(port, '/api/probe', { 'accept-encoding': 'br' })
    expect(sentBeforeBody).toBe(false)
    expect(sentAfterHead).toBe(true)
  })

  it('matches terminal flags and late-end settlement for compressed responses', async () => {
    const events: string[] = []
    const port = await serve((_req, res) => {
      res.on('error', (error) => {
        events.push(`error:${String((error as Error & { code?: string }).code)}`)
      })
      res.once('finish', () => { events.push('finish') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(LARGE_JSON, () => { events.push('first-end') })
      // The compatibility flag is part of the public response contract under test.
      const compatibilityFlags = res as unknown as {
        finished: boolean
        writableEnded: boolean
        writableFinished: boolean
      }
      events.push(`flags:${String(compatibilityFlags.finished)}:${String(compatibilityFlags.writableEnded)}:${String(compatibilityFlags.writableFinished)}`)
      expect(res.write('late', (error) => {
        events.push(`late-write:${String((error as Error & { code?: string }).code)}`)
      })).toBe(false)
      const responseWithTestEnd = res as unknown as {
        end(chunk: string, callback: TestCallback): ServerResponse
      }
      responseWithTestEnd.end('late', (error) => {
        events.push(`late-end:${String((error as Error & { code?: string }).code)}`)
      })
      res.end('', () => { events.push('empty-end') })
    })
    const answer = await raw(port, '/terminal', { 'accept-encoding': 'gzip' })
    expect(gunzipSync(answer.body).toString('utf8')).toBe(LARGE_JSON)
    expect(events[0]).toBe('flags:true:true:false')
    expect(events).toContain('late-write:ERR_STREAM_WRITE_AFTER_END')
    expect(events).toContain('late-end:ERR_STREAM_WRITE_AFTER_END')
    expect(events).toContain('empty-end')
    expect(events).toContain('first-end')
    expect(events).toContain('finish')
  })

  it('runs the completion callbacks of write and end', async () => {
    const seen: string[] = []
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.write('a', () => { seen.push('write-small') })
      res.write(LARGE_JSON, 'utf8', () => { seen.push('write-large') })
      res.end('!', () => { seen.push('end') })
    })
    const answer = await raw(port, '/callbacks', { 'accept-encoding': 'gzip' })
    expect(gunzipSync(answer.body).toString('utf8')).toBe('a' + LARGE_JSON + '!')
    expect(seen).toEqual(['write-small', 'write-large', 'end'])
  })
})

type TestCallback = (error?: Error | null) => void

/** Minimal transform with controllable acceptance and terminal events. */
class ScriptedTransform extends EventEmitter {
  readonly input: Buffer[] = []
  readonly inputCallbacks: TestCallback[] = []
  readonly endInput: Buffer[] = []
  readonly writeResults: boolean[] = []
  destroyed = false
  destroyCount = 0
  destroyError: Error | undefined
  paused = false
  pauseCount = 0
  resumeCount = 0
  throwOnWrite = false
  throwOnEnd = false
  emitDrainDuringWrite = false

  write(chunk: Buffer, callback?: TestCallback): boolean {
    if (this.throwOnWrite) throw new Error('transform write failed')
    this.input.push(chunk)
    if (callback !== undefined) this.inputCallbacks.push(callback)
    if (this.emitDrainDuringWrite) this.emit('drain')
    return this.writeResults.shift() ?? true
  }

  end(chunk?: Buffer): this {
    if (this.throwOnEnd) throw new Error('transform end failed')
    if (chunk !== undefined) this.endInput.push(chunk)
    return this
  }

  pause(): this {
    this.paused = true
    this.pauseCount += 1
    return this
  }

  resume(): this {
    this.paused = false
    this.resumeCount += 1
    return this
  }

  destroy(error?: Error): this {
    this.destroyed = true
    this.destroyCount += 1
    this.destroyError = error
    if (error !== undefined) this.emit('error', error)
    return this
  }
}

/** Response double whose raw end and transform events are driven by each test. */
class ScriptedResponse extends EventEmitter {
  statusCode = 200
  rawFinished = false
  rawWritableEnded = false
  rawWritableFinished = false
  rawHeadersSent = false
  destroyed = false
  destroyCount = 0
  destroyError: Error | undefined
  readonly headers: Record<string, string | number | readonly string[]> = {}
  readonly writes: Buffer[] = []
  readonly committedHeaders: Record<string, unknown> = {}
  readonly observedFinished: boolean[] = []
  readonly writeCallbacks: TestCallback[] = []
  endCallback: TestCallback | undefined
  repeatedEndCallback: TestCallback | undefined
  deferWriteCallbacks = false
  writeResult = true
  throwOnWrite = false
  throwOnEnd = false
  endError: Error | undefined

  get headersSent(): boolean {
    return this.rawHeadersSent
  }

  get finished(): boolean {
    return this.rawFinished
  }

  set finished(value: boolean) {
    this.rawFinished = value
  }

  get writableEnded(): boolean {
    return this.rawWritableEnded
  }

  get writableFinished(): boolean {
    return this.rawWritableFinished
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name.toLowerCase()] = value
    return this
  }

  removeHeader(name: string): void {
    Reflect.deleteProperty(this.headers, name.toLowerCase())
  }

  appendHeader(name: string, value: string | number | readonly string[]): this {
    const key = name.toLowerCase()
    const existing = this.headers[key]
    this.headers[key] = existing === undefined
      ? value
      : [existing, value].flat() as string[]
    return this
  }

  getHeaders(): Record<string, string | number | readonly string[]> {
    return { ...this.headers }
  }

  writeHead(statusCode: number, ...args: unknown[]): this {
    this.statusCode = statusCode
    const provided = typeof args[0] === 'string' ? args[1] : args[0]
    Object.assign(this.committedHeaders, this.headers)
    if (Array.isArray(provided)) {
      for (let at = 0; at + 1 < provided.length; at += 2) {
        this.committedHeaders[String(provided[at]).toLowerCase()] = provided[at + 1]
      }
    } else if (provided !== null && typeof provided === 'object') {
      Object.assign(this.committedHeaders, provided)
    }
    this.rawHeadersSent = true
    return this
  }

  write(chunk?: unknown, callback?: TestCallback): boolean
  write(chunk?: unknown, encoding?: BufferEncoding, callback?: TestCallback): boolean
  write(chunk?: unknown, encoding?: BufferEncoding | TestCallback, callback?: TestCallback): boolean {
    if (this.throwOnWrite) throw new Error('raw write failed')
    this.observedFinished.push(this.finished)
    const done = typeof encoding === 'function' ? encoding : callback
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      this.writes.push(typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
        : Buffer.from(chunk as Uint8Array))
    }
    if (typeof done === 'function') {
      if (this.deferWriteCallbacks) this.writeCallbacks.push(done)
      else done()
    }
    return this.writeResult
  }

  end(callback?: TestCallback): this
  end(chunk?: unknown, callback?: TestCallback): this
  end(chunk?: unknown, encoding?: BufferEncoding, callback?: TestCallback): this
  end(
    _chunk?: unknown,
    _encoding?: BufferEncoding | TestCallback,
    callback?: TestCallback,
  ): this {
    if (this.throwOnEnd) throw new Error('raw end failed')
    this.observedFinished.push(this.finished)
    if (_chunk !== undefined && _chunk !== null && typeof _chunk !== 'function') {
      this.writes.push(typeof _chunk === 'string'
        ? Buffer.from(_chunk, typeof _encoding === 'string' ? _encoding : 'utf8')
        : Buffer.from(_chunk as Uint8Array))
    }
    this.rawWritableEnded = true
    this.rawFinished = true
    this.endCallback = typeof _encoding === 'function' ? _encoding : callback
    return this
  }

  flushHeaders(): void {
    this.rawHeadersSent = true
  }

  destroy(error?: Error): this {
    this.destroyCount += 1
    this.destroyError = error
    this.destroyed = true
    this.emit('close')
    return this
  }

  abort(): void {
    this.destroyed = true
    this.emit('close')
  }

  completeEnd(error?: Error): void {
    const callback = this.endCallback
    this.endCallback = undefined
    this.repeatedEndCallback = callback
    if (error !== undefined || this.endError !== undefined) {
      callback?.(error ?? this.endError)
      return
    }
    this.rawWritableFinished = true
    callback?.()
    this.emit('finish')
    this.emit('close')
  }

  repeatEndCompletion(error?: Error): void {
    this.repeatedEndCallback?.(error)
  }

  completeWrites(error?: Error): void {
    const callbacks = this.writeCallbacks.splice(0)
    for (const callback of callbacks) callback(error)
  }
}

function scriptedRequest(
  acceptEncoding = 'gzip',
  method = 'GET',
  url = '/api/scripted',
): IncomingMessage {
  return {
    method,
    url,
    headers: { 'accept-encoding': acceptEncoding },
  } as IncomingMessage
}

function applyScriptedPolicy(
  response: ScriptedResponse,
  transform: ScriptedTransform,
  policy: ResponsePolicy,
  onError: (error: Error) => void = () => {},
  request: IncomingMessage = scriptedRequest(),
): void {
  applyResponsePolicyWithRuntime(
    request,
    response as unknown as ServerResponse,
    policy,
    onError,
    {
      createCompressor: () => transform as unknown as Transform,
      nextTick: (callback) => { callback() },
    },
  )
}

describe('injected response policy runtime', () => {
  it('splits an oversized end at the threshold before feeding the compressor', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.end('abcdefghij', (error) => { endErrors.push(error) })

    expect(Buffer.concat(transform.input.concat(transform.endInput)).toString()).toBe('abcdefghij')
    expect(transform.input[0]?.toString()).toBe('abcde')
    expect(transform.endInput[0]?.toString()).toBe('fghij')
    expect(endErrors).toEqual([])

    transform.emit('data', Buffer.from('encoded'))
    transform.emit('end')
    expect(response.endCallback).toBeDefined()
    response.completeEnd()
    expect(endErrors).toEqual([undefined])
  })

  it.each([0, -1])('normalizes a minBytes value of %s to immediate compression', (minBytes) => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.end('body', (error) => { endErrors.push(error) })

    expect(response.committedHeaders['content-encoding']).toBe('gzip')
    expect(transform.input).toEqual([])
    expect(transform.endInput.map(chunk => chunk.toString())).toEqual(['body'])
    expect(endErrors).toEqual([])

    transform.emit('end')
    response.completeEnd()
    expect(endErrors).toEqual([undefined])
  })

  it('compresses an exact threshold body and does not exceed the retained bound', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.end('abcde', (error) => { endErrors.push(error) })

    expect(transform.input.map(chunk => chunk.byteLength)).toEqual([5])
    expect(transform.endInput).toEqual([])
    expect(endErrors).toEqual([])

    transform.emit('end')
    response.completeEnd()
    expect(endErrors).toEqual([undefined])
  })

  it('splits multiwrite threshold crossing and settles a write callback at transform acceptance', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const writeErrors: (Error | null | undefined)[] = []
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('ab', (error) => { writeErrors.push(error) })
    response.write('cdefgh', (error) => { writeErrors.push(error) })

    expect(transform.input.map(chunk => chunk.toString())).toEqual(['ab', 'cde', 'fgh'])
    expect(transform.input.slice(0, 2).reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(5)
    expect(writeErrors).toEqual([])
    for (const callback of transform.inputCallbacks) callback()
    expect(writeErrors).toEqual([undefined, undefined])

    response.end((error) => { endErrors.push(error) })
    transform.emit('end')
    response.completeEnd()
    expect(endErrors).toEqual([undefined])
    expect(writeErrors).toHaveLength(2)
  })

  it('keeps compressor and sink backpressure separate and emits one owed public drain', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const drains: string[] = []
    const removed = (): void => { drains.push('removed') }
    const onDrain = (): void => { drains.push('on') }
    const onceDrain = (): void => { drains.push('once') }

    transform.writeResults.push(false)
    response.writeResult = false
    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    response.on('drain', onDrain)
    response.once('drain', onceDrain)
    response.on('drain', removed)
    response.off('drain', removed)
    expect(response.listenerCount('drain')).toBe(2)
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)

    expect(response.write('body')).toBe(false)
    expect(transform.paused).toBe(false)
    transform.emit('data', Buffer.from('encoded'))
    expect(transform.paused).toBe(true)
    expect(response.listenerCount('drain')).toBe(2)

    response.emit('drain')
    expect(transform.paused).toBe(false)
    expect(transform.resumeCount).toBe(1)
    expect(drains).toEqual([])

    transform.emit('drain')
    expect(drains).toEqual(['on', 'once'])
    expect(response.listenerCount('drain')).toBe(1)
    transform.emit('drain')
    expect(drains).toEqual(['on', 'once'])
  })

  it('reports one transform error, settles callbacks once, and destroys without finishing', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const errors: Error[] = []
    const writeErrors: (Error | null | undefined)[] = []
    const endErrors: (Error | null | undefined)[] = []
    const destroyCountsAtReport: number[] = []
    const failure = new Error('transform failed')

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    }, (error) => {
      errors.push(error)
      destroyCountsAtReport.push(response.destroyCount)
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('body', (error) => { writeErrors.push(error) })
    response.end('tail', (error) => { endErrors.push(error) })

    transform.emit('error', failure)
    transform.emit('error', new Error('duplicate'))
    for (const callback of transform.inputCallbacks) callback()

    expect(errors).toEqual([failure])
    expect(destroyCountsAtReport).toEqual([0])
    expect(writeErrors).toEqual([failure])
    expect(endErrors).toEqual([failure])
    expect(transform.destroyCount).toBe(1)
    expect(transform.destroyError).toBe(failure)
    expect(response.destroyCount).toBe(1)
    expect(response.destroyError).toBe(failure)
    expect(response.rawWritableFinished).toBe(false)
  })

  it('settles buffered callbacks on a client abort before compression without reporting an error', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const errors: Error[] = []
    const writeErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    }, (error) => { errors.push(error) })
    response.on('error', () => {})
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('abc', (error) => { writeErrors.push(error) })
    response.abort()
    response.abort()

    expect(errors).toEqual([])
    expect(writeErrors).toHaveLength(1)
    expect((writeErrors[0] as Error & { code?: string }).code).toBe('ECANCELED')
    expect(transform.destroyCount).toBe(0)
    expect(response.destroyCount).toBe(0)
    expect(response.rawWritableFinished).toBe(false)
  })

  it('destroys an active compressor once when a client aborts after compression starts', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const errors: Error[] = []
    const writeErrors: (Error | null | undefined)[] = []
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    }, (error) => { errors.push(error) })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('abc', (error) => { writeErrors.push(error) })
    response.end('tail', (error) => { endErrors.push(error) })
    response.abort()
    response.abort()

    expect(errors).toEqual([])
    expect(writeErrors).toHaveLength(1)
    expect(endErrors).toHaveLength(1)
    expect((endErrors[0] as Error & { code?: string }).code).toBe('ECANCELED')
    expect(transform.destroyCount).toBe(1)
    expect(response.destroyCount).toBe(0)
    expect(response.rawWritableFinished).toBe(false)
  })

  it('unregisters passthrough write callbacks when the client aborts', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const writeErrors: (Error | null | undefined)[] = []

    response.deferWriteCallbacks = true
    applyScriptedPolicy(response, transform, POLICY)
    response.writeHead(200, { 'content-type': 'image/png' })
    response.write(Buffer.from('png'), (error) => { writeErrors.push(error) })
    response.abort()
    response.completeWrites()

    expect(writeErrors).toHaveLength(1)
    expect((writeErrors[0] as Error & { code?: string }).code).toBe('ECANCELED')
    expect(transform.destroyCount).toBe(0)
  })

  it('copies frozen object and flat writeHead headers without mutating the caller input', () => {
    const objectResponse = new ScriptedResponse()
    const objectTransform = new ScriptedTransform()
    const objectHeaders = Object.freeze({
      'content-type': 'text/plain',
      vary: 'Origin',
      'content-length': '10',
    })
    applyScriptedPolicy(objectResponse, objectTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    objectResponse.writeHead(200, objectHeaders)
    objectResponse.end('0123456789')

    expect(objectHeaders).toEqual({
      'content-type': 'text/plain',
      vary: 'Origin',
      'content-length': '10',
    })
    expect(objectResponse.committedHeaders.vary).toBe('Origin, Accept-Encoding')
    expect(objectResponse.committedHeaders['content-encoding']).toBe('gzip')
    expect(objectResponse.committedHeaders['content-length']).toBeUndefined()

    const flatResponse = new ScriptedResponse()
    const flatTransform = new ScriptedTransform()
    applyScriptedPolicy(flatResponse, flatTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 2 },
    })
    flatResponse.writeHead(200, ['content-type', 'text/plain', 'vary', 'Origin'])
    flatResponse.end('abc')

    expect(flatResponse.committedHeaders.vary).toBe('Origin, Accept-Encoding')
    expect(flatResponse.committedHeaders['content-encoding']).toBe('gzip')
  })

  it('keeps terminal flags truthful and settles repeated empty end callbacks after physical end', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const events: string[] = []
    const errorCode = (error: unknown): string | undefined => {
      if (error === null || typeof error !== 'object' || !('code' in error)) return undefined
      return typeof error.code === 'string' ? error.code : undefined
    }

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    response.on('error', (error) => { events.push(`error:${String(errorCode(error))}`) })
    response.once('finish', () => { events.push('finish') })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('body', (error) => { events.push('first-end:' + String(error)) })
    response.end('', (error) => { events.push('empty-before:' + String(error)) })
    response.end('')

    expect(response.finished).toBe(true)
    expect(response.writableEnded).toBe(true)
    expect(response.writableFinished).toBe(false)
    expect(response.write('late', (error) => { events.push(`late-write:${String(errorCode(error))}`) })).toBe(false)
    response.end('late', (error) => { events.push(`late-end:${String(errorCode(error))}`) })

    transform.emit('end')
    response.completeEnd()
    response.end('', (error) => { events.push('empty-after:' + String(error)) })

    expect(events).toEqual([
      'late-write:ERR_STREAM_WRITE_AFTER_END',
      'error:ERR_STREAM_WRITE_AFTER_END',
      'late-end:ERR_STREAM_WRITE_AFTER_END',
      'error:ERR_STREAM_WRITE_AFTER_END',
      'first-end:undefined',
      'empty-before:undefined',
      'finish',
      'empty-after:undefined',
    ])
    expect(response.rawWritableFinished).toBe(true)
  })

  it('drives the under-threshold passthrough and flushHeaders paths with accepted callbacks', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const writeErrors: (Error | null | undefined)[] = []
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, POLICY)
    response.setHeader('content-type', 'text/plain')
    response.appendHeader('vary', 'Origin')
    response.removeHeader('missing')
    response.writeHead(201, 'Created', { 'x-probe': 'yes' })
    response.write('ab', (error) => { writeErrors.push(error) })
    response.end('cd', (error) => { endErrors.push(error) })
    response.completeEnd()

    expect(response.committedHeaders['x-probe']).toBe('yes')
    expect(response.committedHeaders.vary).toBe('Origin, Accept-Encoding')
    expect(response.committedHeaders['content-encoding']).toBeUndefined()
    expect(Buffer.concat(response.writes).toString()).toBe('abcd')
    expect(writeErrors).toEqual([undefined])
    expect(endErrors).toEqual([undefined])

    const flushed = new ScriptedResponse()
    const flushedTransform = new ScriptedTransform()
    const flushedEnd: (Error | null | undefined)[] = []
    applyScriptedPolicy(flushed, flushedTransform, POLICY)
    flushed.setHeader('content-type', 'text/plain')
    flushed.writeHead(200)
    flushed.write('held')
    flushed.flushHeaders()
    expect(flushed.rawHeadersSent).toBe(true)
    expect(flushed.committedHeaders['content-encoding']).toBeUndefined()
    flushed.end('after', (error) => { flushedEnd.push(error) })
    flushed.completeEnd()
    expect(Buffer.concat(flushed.writes).toString()).toBe('heldafter')
    expect(flushedEnd).toEqual([undefined])
  })

  it('keeps identity, disabled compression, and excluded response classes verbatim', () => {
    const identity = new ScriptedResponse()
    const identityTransform = new ScriptedTransform()
    applyScriptedPolicy(identity, identityTransform, POLICY, () => {}, scriptedRequest('identity'))
    identity.setHeader('content-type', 'text/plain')
    identity.writeHead(200)
    identity.end('identity')
    identity.completeEnd()
    expect(identity.committedHeaders['content-encoding']).toBeUndefined()
    expect(identity.committedHeaders.vary).toBe('Accept-Encoding')

    const disabled = new ScriptedResponse()
    const disabledTransform = new ScriptedTransform()
    applyScriptedPolicy(disabled, disabledTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, enabled: false },
    })
    disabled.setHeader('content-type', 'text/plain')
    disabled.writeHead(200)
    disabled.end('disabled')
    disabled.completeEnd()
    expect(disabled.committedHeaders['content-encoding']).toBeUndefined()
    expect(disabled.committedHeaders.vary).toBeUndefined()

    const rangedRequest = scriptedRequest()
    rangedRequest.headers.range = 'bytes=0-2'
    const excluded: Array<{ status?: number; headers?: Record<string, string>; request?: IncomingMessage }> = [
      { status: 204 },
      { status: 205 },
      { status: 206 },
      { headers: { 'content-range': 'bytes 0-2/9' } },
      { headers: { 'cache-control': 'public, no-transform' } },
      { headers: { 'content-encoding': 'gzip' } },
      { request: scriptedRequest('gzip', 'HEAD') },
      { request: rangedRequest },
    ]
    for (const entry of excluded) {
      const response = new ScriptedResponse()
      const transform = new ScriptedTransform()
      applyScriptedPolicy(response, transform, POLICY, () => {}, entry.request)
      response.writeHead(entry.status ?? 200, {
        'content-type': 'application/json',
        ...entry.headers,
      })
      response.end('excluded')
      response.completeEnd()
      expect(response.committedHeaders['content-encoding']).toBe(entry.headers?.['content-encoding'])
      expect(response.committedHeaders.vary).toBeUndefined()
    }
  })

  it('preserves lifecycle listeners when a handler clears EventEmitter registrations', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const callbackErrors: (Error | null | undefined)[] = []
    const drain = (): void => {}

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('a', (error) => { callbackErrors.push(error) })
    response.on('drain', drain)
    expect(response.eventNames()).toContain('drain')
    response.removeAllListeners('drain')
    expect(response.listenerCount('drain')).toBe(0)
    response.removeAllListeners('error')
    response.removeAllListeners()
    response.abort()

    expect(callbackErrors).toHaveLength(1)
    expect((callbackErrors[0] as Error & { code?: string }).code).toBe('ECANCELED')
  })

  it('does not turn a close after physical finish into an abort', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.end('body', (error) => { endErrors.push(error) })
    transform.emit('end')

    const endCallback = response.endCallback
    response.endCallback = undefined
    response.rawWritableFinished = true
    response.emit('finish')
    response.emit('close')
    endCallback?.()

    expect(endErrors).toEqual([undefined])
    expect(response.destroyCount).toBe(0)
  })

  it('reports compressor callback, write, end, and setup failures through one teardown path', () => {
    const callbackResponse = new ScriptedResponse()
    const callbackTransform = new ScriptedTransform()
    const callbackErrors: Error[] = []
    const callbackFailure = new Error('transform callback failed')
    applyScriptedPolicy(callbackResponse, callbackTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    }, (error) => { callbackErrors.push(error) })
    callbackResponse.setHeader('content-type', 'text/plain')
    callbackResponse.writeHead(200)
    callbackResponse.write('body', () => {})
    callbackTransform.inputCallbacks[0]?.(callbackFailure)
    expect(callbackErrors).toEqual([callbackFailure])
    expect(callbackResponse.destroyCount).toBe(1)

    const writeResponse = new ScriptedResponse()
    const writeTransform = new ScriptedTransform()
    const writeErrors: Error[] = []
    const writeReports: Error[] = []
    writeTransform.throwOnWrite = true
    applyScriptedPolicy(writeResponse, writeTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    }, (error) => { writeReports.push(error) })
    writeResponse.setHeader('content-type', 'text/plain')
    writeResponse.writeHead(200)
    writeResponse.write('body', (error) => { writeErrors.push(error as Error) })
    expect(writeReports).toHaveLength(1)
    expect(writeErrors).toHaveLength(1)
    expect(writeResponse.destroyCount).toBe(1)

    const endResponse = new ScriptedResponse()
    const endTransform = new ScriptedTransform()
    const endErrors: Error[] = []
    endTransform.throwOnEnd = true
    applyScriptedPolicy(endResponse, endTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    }, (error) => { endErrors.push(error) })
    endResponse.setHeader('content-type', 'text/plain')
    endResponse.writeHead(200)
    endResponse.write('body')
    endResponse.end()
    expect(endErrors).toHaveLength(1)
    expect(endResponse.destroyCount).toBe(1)

    const setupResponse = new ScriptedResponse()
    const setupErrors: Error[] = []
    const setupFailure = new Error('compressor setup failed')
    applyResponsePolicyWithRuntime(
      scriptedRequest(),
      setupResponse as unknown as ServerResponse,
      {
        ...POLICY,
        compression: { ...POLICY.compression, minBytes: 0 },
      },
      (error) => { setupErrors.push(error) },
      {
        createCompressor: () => { throw setupFailure },
        nextTick: (callback) => { callback() },
      },
    )
    setupResponse.setHeader('content-type', 'text/plain')
    setupResponse.writeHead(200)
    setupResponse.end('body')
    expect(setupErrors).toEqual([setupFailure])
    expect(setupResponse.destroyCount).toBe(1)

    const thrownResponse = new ScriptedResponse()
    const thrownErrors: Error[] = []
    applyResponsePolicyWithRuntime(
      scriptedRequest(),
      thrownResponse as unknown as ServerResponse,
      {
        ...POLICY,
        compression: { ...POLICY.compression, minBytes: 0 },
      },
      (error) => { thrownErrors.push(error) },
      {
        createCompressor: () => { throw 'compressor setup failed without an Error' },
        nextTick: (callback) => { callback() },
      },
    )
    thrownResponse.setHeader('content-type', 'text/plain')
    thrownResponse.writeHead(200)
    thrownResponse.write('body')
    expect(thrownErrors[0]?.message).toBe('compressor setup failed without an Error')
    expect(thrownResponse.destroyCount).toBe(1)
    thrownResponse.end()

    const callbackAfterFailure = new ScriptedResponse()
    const callbackAfterFailureEnds: Error[] = []
    applyResponsePolicyWithRuntime(
      scriptedRequest(),
      callbackAfterFailure as unknown as ServerResponse,
      {
        ...POLICY,
        compression: { ...POLICY.compression, minBytes: 0 },
      },
      () => {},
      {
        createCompressor: () => { throw new Error('callback-after-failure setup') },
        nextTick: (callback) => { callback() },
      },
    )
    callbackAfterFailure.setHeader('content-type', 'text/plain')
    callbackAfterFailure.writeHead(200)
    callbackAfterFailure.write('body')
    const callbackAfterFailureWrites: Error[] = []
    callbackAfterFailure.write('after')
    callbackAfterFailure.write('after', (error) => {
      if (error !== undefined && error !== null) callbackAfterFailureWrites.push(error)
    })
    callbackAfterFailure.end((error) => {
      if (error !== undefined && error !== null) callbackAfterFailureEnds.push(error)
    })
    expect(callbackAfterFailureWrites).toHaveLength(1)
    expect(callbackAfterFailureEnds).toHaveLength(1)
  })

  it('fails a passthrough response when the raw sink throws or ends with an error', () => {
    const writeResponse = new ScriptedResponse()
    const writeTransform = new ScriptedTransform()
    const writeErrors: (Error | null | undefined)[] = []
    writeResponse.throwOnWrite = true
    applyScriptedPolicy(writeResponse, writeTransform, POLICY)
    writeResponse.writeHead(200, { 'content-type': 'image/png' })
    writeResponse.write('png', (error) => { writeErrors.push(error) })
    expect(writeErrors).toHaveLength(1)
    expect(writeResponse.destroyCount).toBe(1)

    const endResponse = new ScriptedResponse()
    const endTransform = new ScriptedTransform()
    const endErrors: (Error | null | undefined)[] = []
    endResponse.throwOnEnd = true
    applyScriptedPolicy(endResponse, endTransform, POLICY)
    endResponse.writeHead(200, { 'content-type': 'image/png' })
    endResponse.end('png', (error) => { endErrors.push(error) })
    expect(endErrors).toHaveLength(1)
    expect(endResponse.destroyCount).toBe(1)

    const completionResponse = new ScriptedResponse()
    const completionTransform = new ScriptedTransform()
    const completionErrors: (Error | null | undefined)[] = []
    applyScriptedPolicy(completionResponse, completionTransform, POLICY)
    completionResponse.writeHead(200, { 'content-type': 'image/png' })
    completionResponse.end('png', (error) => { completionErrors.push(error) })
    const failure = new Error('raw end failed')
    completionResponse.completeEnd(failure)
    expect(completionErrors).toEqual([failure])
    expect(completionResponse.rawWritableFinished).toBe(false)
  })

  it('handles header overloads, typed-array bodies, implicit status, and callback-first end', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const writeErrors: (Error | null | undefined)[] = []
    const endErrors: (Error | null | undefined)[] = []
    const finish = (): void => {}

    applyScriptedPolicy(response, transform, POLICY)
    response.finished = false
    response.setHeader('content-type', 'text/plain')
    response.setHeader('vary', ['Origin'])
    response.appendHeader('vary', ['Region'])
    response.addListener('finish', finish)
    response.removeListener('finish', finish)
    response.off('drain', finish)
    expect(response.headersSent).toBe(false)
    response.writeHead(201, 'Created', ['x-flat', ['one', 'two']])
    expect(response.headersSent).toBe(true)
    response.write(new Uint8Array([97]), (error) => { writeErrors.push(error) })
    response.write(null)
    response.write('')
    response.end((error) => { endErrors.push(error) })
    response.completeEnd()

    expect(response.statusCode).toBe(201)
    expect(response.committedHeaders['x-flat']).toEqual(['one', 'two'])
    expect(response.committedHeaders.vary).toBe('Origin, Region, Accept-Encoding')
    expect(Buffer.concat(response.writes).toString()).toBe('a')
    expect(writeErrors).toEqual([undefined])
    expect(endErrors).toEqual([undefined])
  })

  it('rejects header changes and body writes after an aborted response', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const writeErrors: (Error | null | undefined)[] = []
    const endErrors: (Error | null | undefined)[] = []

    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    expect(() => response.writeHead(200)).toThrow(/headers after they are sent/)
    expect(() => response.setHeader('x-late', '1')).toThrow(/headers after they are sent/)
    expect(() => { response.removeHeader('x-late') }).toThrow(/headers after they are sent/)
    expect(() => response.appendHeader('x-late', '1')).toThrow(/headers after they are sent/)
    response.write('held', (error) => { writeErrors.push(error) })
    response.abort()
    response.end()
    expect(response.write('after-without-callback')).toBe(false)
    expect(response.write('after', (error) => { writeErrors.push(error) })).toBe(false)
    response.end('', (error) => { endErrors.push(error) })

    expect(writeErrors).toHaveLength(2)
    expect((writeErrors[0] as Error & { code?: string }).code).toBe('ECANCELED')
    expect((writeErrors[1] as Error & { code?: string }).code).toBe('ERR_STREAM_WRITE_AFTER_END')
    expect(endErrors).toHaveLength(1)
    expect((endErrors[0] as Error & { code?: string }).code).toBe('ECANCELED')
    expect(response.destroyCount).toBe(0)
  })

  it('covers overload normalization, implicit decisions, and terminal guards', () => {
    const accepted = new ScriptedResponse()
    const acceptedTransform = new ScriptedTransform()
    const acceptedWrites: (Error | null | undefined)[] = []
    const acceptedEnds: (Error | null | undefined)[] = []
    applyScriptedPolicy(accepted, acceptedTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    accepted.setHeader('content-type', 'text/plain')
    accepted.writeHead(200)
    expect(accepted.finished).toBe(false)
    expect(accepted.writableEnded).toBe(false)
    accepted.write(() => { acceptedWrites.push(undefined) })
    accepted.write('', (error) => { acceptedWrites.push(error) })
    accepted.write(Buffer.from('abc'), 'utf8', (error) => { acceptedWrites.push(error) })
    accepted.write('middle')
    accepted.end('tail', 'utf8', (error) => { acceptedEnds.push(error) })
    for (const callback of acceptedTransform.inputCallbacks) callback()
    acceptedTransform.emit('end')
    accepted.completeEnd()
    accepted.repeatEndCompletion()

    expect(acceptedWrites).toEqual([undefined, undefined, undefined])
    expect(acceptedEnds).toEqual([undefined])
    expect(acceptedTransform.input[0]?.toString()).toBe('abc')
    expect(acceptedTransform.endInput[0]?.toString()).toBe('tail')
    expect(accepted.observedFinished).toContain(false)

    const explicitVary = new ScriptedResponse()
    const explicitVaryTransform = new ScriptedTransform()
    applyScriptedPolicy(explicitVary, explicitVaryTransform, POLICY)
    explicitVary.setHeader('content-type', 'text/plain')
    explicitVary.setHeader('vary', ['Accept-Encoding'])
    explicitVary.writeHead(200)
    explicitVary.end('body')
    explicitVary.completeEnd()
    expect(explicitVary.committedHeaders.vary).toEqual('Accept-Encoding')

    const wildcardVary = new ScriptedResponse()
    const wildcardVaryTransform = new ScriptedTransform()
    applyScriptedPolicy(wildcardVary, wildcardVaryTransform, POLICY)
    wildcardVary.setHeader('content-type', 'text/plain')
    wildcardVary.setHeader('vary', '*')
    wildcardVary.writeHead(200)
    wildcardVary.end('body')
    wildcardVary.completeEnd()
    expect(wildcardVary.committedHeaders.vary).toBe('*')

    const lateResponse = new ScriptedResponse()
    const lateTransform = new ScriptedTransform()
    const lateErrors: Error[] = []
    applyScriptedPolicy(lateResponse, lateTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    lateResponse.on('error', (error) => {
      if (error instanceof Error) lateErrors.push(error)
    })
    lateResponse.setHeader('content-type', 'text/plain')
    lateResponse.writeHead(200)
    lateResponse.end('body')
    expect(lateResponse.write('late')).toBe(false)
    lateTransform.emit('end')
    lateResponse.completeEnd()
    expect(lateErrors).toHaveLength(1)

    const exactWrite = new ScriptedResponse()
    const exactWriteTransform = new ScriptedTransform()
    const exactWriteErrors: (Error | null | undefined)[] = []
    applyScriptedPolicy(exactWrite, exactWriteTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    exactWrite.setHeader('content-type', 'text/plain')
    exactWrite.writeHead(200)
    exactWrite.write('abc')
    exactWrite.write('de', (error) => { exactWriteErrors.push(error) })
    for (const callback of exactWriteTransform.inputCallbacks) callback()
    exactWrite.end()
    exactWriteTransform.emit('end')
    exactWrite.completeEnd()
    expect(exactWriteErrors).toEqual([undefined])

    const handlerCache = new ScriptedResponse()
    const handlerCacheTransform = new ScriptedTransform()
    applyScriptedPolicy(handlerCache, handlerCacheTransform, POLICY)
    handlerCache.setHeader('content-type', 'text/plain')
    handlerCache.setHeader('cache-control', 'public, max-age=60')
    handlerCache.writeHead(200)
    handlerCache.end('body')
    handlerCache.completeEnd()
    expect(handlerCache.committedHeaders['cache-control']).toBe('public, max-age=60')

    const implicit = new ScriptedResponse()
    const implicitTransform = new ScriptedTransform()
    const implicitEnds: (Error | null | undefined)[] = []
    applyScriptedPolicy(implicit, implicitTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 4 },
    })
    implicit.setHeader('content-type', 'text/plain')
    expect(implicit.finished).toBe(false)
    implicit.write('ab')
    implicit.end((error) => { implicitEnds.push(error) })
    implicit.completeEnd()
    expect(implicit.committedHeaders['content-encoding']).toBeUndefined()
    expect(implicitEnds).toEqual([undefined])

    const flushFirst = new ScriptedResponse()
    const flushFirstTransform = new ScriptedTransform()
    applyScriptedPolicy(flushFirst, flushFirstTransform, POLICY)
    flushFirst.setHeader('content-type', 'text/plain')
    flushFirst.flushHeaders()
    flushFirst.flushHeaders()
    expect(flushFirst.rawHeadersSent).toBe(true)
    expect(flushFirst.committedHeaders.vary).toBe('Accept-Encoding')

    const nonSuccess = new ScriptedResponse()
    const nonSuccessTransform = new ScriptedTransform()
    const noUrlRequest = scriptedRequest()
    noUrlRequest.url = undefined
    applyScriptedPolicy(nonSuccess, nonSuccessTransform, POLICY, () => {}, noUrlRequest)
    nonSuccess.setHeader('content-type', 'text/plain')
    nonSuccess.writeHead(300)
    nonSuccess.end('not found')
    nonSuccess.completeEnd()
    expect(nonSuccess.committedHeaders['cache-control']).toBe('no-cache')

    const noUrlSuccess = new ScriptedResponse()
    const noUrlSuccessTransform = new ScriptedTransform()
    const noUrlSuccessRequest = scriptedRequest()
    noUrlSuccessRequest.url = undefined
    applyScriptedPolicy(noUrlSuccess, noUrlSuccessTransform, POLICY, () => {}, noUrlSuccessRequest)
    noUrlSuccess.setHeader('content-type', 'text/plain')
    noUrlSuccess.writeHead(200)
    noUrlSuccess.end('body')
    noUrlSuccess.completeEnd()

    const directEnd = new ScriptedResponse()
    const directEndTransform = new ScriptedTransform()
    applyScriptedPolicy(directEnd, directEndTransform, POLICY)
    directEnd.setHeader('content-type', 'text/plain')
    directEnd.end('body')
    directEnd.completeEnd()
    expect(directEnd.committedHeaders['content-encoding']).toBeUndefined()

    const numberHeader = new ScriptedResponse()
    const numberTransform = new ScriptedTransform()
    applyScriptedPolicy(numberHeader, numberTransform, POLICY)
    numberHeader.setHeader('content-type', 'image/png')
    numberHeader.appendHeader('x-number', 7)
    numberHeader.writeHead(200)
    numberHeader.end(Buffer.from('png'), 'utf8')
    numberHeader.completeEnd()
    expect(numberHeader.committedHeaders['x-number']).toBe('7')
  })

  it('keeps the threshold bounded for non-finite values and reentrant drain events', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    transform.emitDrainDuringWrite = true
    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: Number.NaN },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('body')
    response.end()
    transform.emit('end')
    response.completeEnd()

    expect(transform.input.map(chunk => chunk.toString())).toEqual(['body'])
    expect(transform.endInput).toEqual([])
  })

  it('does not repeat teardown when a compressed sink fails more than once', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    response.throwOnWrite = true
    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.end('body')
    transform.emit('data', Buffer.from('encoded'))
    transform.emit('data', Buffer.from('late'))

    expect(response.destroyCount).toBe(1)
    expect(transform.destroyCount).toBe(1)
  })

  it('stops flushing retained records after the raw sink fails', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 5 },
    })
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('a')
    response.write('b')
    response.throwOnWrite = true
    response.end()

    expect(response.destroyCount).toBe(1)
    expect(response.writes).toEqual([])
  })

  it('uses the add/remove drain overloads and reports non-drain listener counts', () => {
    const response = new ScriptedResponse()
    const transform = new ScriptedTransform()
    const drains: string[] = []
    const added = (): void => { drains.push('added') }
    const removed = (): void => { drains.push('removed') }
    const first = (): void => {
      drains.push('first')
      response.removeListener('drain', removed)
    }

    transform.writeResults.push(false)
    response.writeResult = false
    applyScriptedPolicy(response, transform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    response.addListener('drain', first)
    response.addListener('drain', removed)
    response.on('drain', added)
    response.removeListener('drain', removed)
    response.on('finish', removed)
    response.off('finish', removed)
    response.writeHead(200)
    response.write('body')
    expect(response.listenerCount('finish')).toBe(1)
    response.emit('drain')
    transform.emit('drain')

    expect(drains).toEqual(['first', 'added'])

    const clearResponse = new ScriptedResponse()
    const clearTransform = new ScriptedTransform()
    const clearEvents: string[] = []
    const clear = (): void => {
      clearEvents.push('clear')
      clearResponse.removeAllListeners('drain')
    }
    const survivor = (): void => { clearEvents.push('survivor') }
    clearTransform.writeResults.push(false)
    clearResponse.writeResult = false
    applyScriptedPolicy(clearResponse, clearTransform, {
      ...POLICY,
      compression: { ...POLICY.compression, minBytes: 0 },
    })
    clearResponse.addListener('drain', clear)
    clearResponse.once('drain', survivor)
    clearResponse.setHeader('content-type', 'text/plain')
    clearResponse.writeHead(200)
    clearResponse.write('body')
    clearTransform.emit('data', Buffer.from('encoded'))
    clearResponse.emit('drain')
    clearTransform.emit('drain')
    expect(clearEvents).toEqual(['clear', 'survivor'])
  })

  it('covers the production runtime wrapper on an identity passthrough response', async () => {
    const response = new ScriptedResponse()
    const errors: (Error | null | undefined)[] = []

    applyResponsePolicy(
      scriptedRequest(),
      response as unknown as ServerResponse,
      POLICY,
      () => {},
    )
    response.setHeader('content-type', 'text/plain')
    response.writeHead(200)
    response.write('', (error) => { errors.push(error) })
    response.end((error) => { errors.push(error) })
    response.completeEnd()
    await new Promise<void>((resolve) => { process.nextTick(resolve) })

    expect(response.committedHeaders['content-encoding']).toBeUndefined()
    expect(errors).toEqual([undefined, undefined])
  })
})

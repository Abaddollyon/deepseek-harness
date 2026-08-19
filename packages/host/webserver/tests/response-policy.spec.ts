/**
 * Behavior of the carrier's response policy: which coding a client's
 * Accept-Encoding earns, which bodies stay verbatim, and which URLs a browser
 * may reuse without asking. The HTTP assertions run against a real node:http
 * server patched by {@link applyResponsePolicy}, so they observe the bytes and
 * fields a browser would.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { cacheControlFor } from '../src/response-cache.ts'
import { isCompressibleMediaType, selectResponseEncoding } from '../src/response-encoding.ts'
import { applyResponsePolicy, type ResponsePolicy } from '../src/response-policy.ts'

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
      .toBe('public, max-age=31536000, immutable')
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
      .toBe('public, max-age=31536000, immutable')
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

  it('appends to a Vary the handler already stated, and accepts the flat header form', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, ['content-type', 'application/json; charset=utf-8', 'vary', 'Origin'])
      res.end(LARGE_JSON)
    })
    const answer = await raw(port, '/api/session.history', { 'accept-encoding': 'br' })
    expect(answer.headers.vary).toBe('Origin, Accept-Encoding')
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

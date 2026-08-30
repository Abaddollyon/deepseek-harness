/** Direct listener-boundary coverage for WebServer when a real socket cannot bind. */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void

interface MockServer extends EventEmitter {
  requestListener: RequestListener
  closed: boolean
  listen: (...args: unknown[]) => MockServer
  address: () => AddressInfo
  close: (callback?: () => void) => MockServer
  closeAllConnections: () => void
}

const state = vi.hoisted(() => ({
  servers: [] as MockServer[],
  policyCalls: [] as unknown[],
  policyErrors: [] as Error[],
}))

vi.mock('node:http', () => ({
  createServer: (requestListener: RequestListener): MockServer => {
    const server = new EventEmitter() as MockServer
    server.requestListener = requestListener
    server.closed = false
    server.listen = ((...args: unknown[]) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        const invoke = callback as () => void
        invoke()
      }
      return server
    })
    server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 43210 })
    server.close = ((callback?: () => void) => {
      server.closed = true
      callback?.()
      return server
    })
    server.closeAllConnections = vi.fn()
    state.servers.push(server)
    return server
  },
}))

vi.mock('../src/response-policy.ts', () => ({
  applyResponsePolicy: (
    _request: IncomingMessage,
    _response: ServerResponse,
    policy: unknown,
    onError: (error: Error) => void,
  ): void => {
    state.policyCalls.push(policy)
    const error = state.policyErrors.shift()
    if (error !== undefined) onError(error)
  },
}))

class MockDestroyable extends EventEmitter {
  statusCode: number | undefined
  headersSent = false
  destroyed = false
  destroyCount = 0
  destroyError: Error | undefined

  destroy(error?: Error): this {
    this.destroyed = true
    this.destroyCount += 1
    this.destroyError = error
    this.emit('close')
    return this
  }
}

class MockResponse extends MockDestroyable {
  body = ''

  writeHead(statusCode: number): this {
    this.statusCode = statusCode
    this.headersSent = true
    return this
  }

  end(chunk?: unknown): this {
    if (typeof chunk === 'string') this.body += chunk
    return this
  }

}

class MockSocket extends MockDestroyable {
  write(_chunk: unknown): boolean {
    return true
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  state.servers.length = 0
  state.policyCalls.length = 0
  state.policyErrors.length = 0
})

function request(url: string | object): IncomingMessage {
  return { method: 'GET', url: url as string, headers: {} } as IncomingMessage
}

async function dispatch(server: MockServer, url: string | object, response: MockResponse): Promise<void> {
  server.requestListener(request(url), response as unknown as ServerResponse)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

async function dispatchUpgrade(server: MockServer, url: string | object, socket: MockSocket): Promise<void> {
  server.emit('upgrade', request(url), socket, Buffer.alloc(0))
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('WebServer listener boundaries', () => {
  it('covers config resolution, routing errors, upgrade errors, and disposal', async () => {
    const { default: WebServer } = await import('../src/index.ts')
    const baseConfig = { host: '127.0.0.1' as const, port: 0 }
    for (const invalid of ['/assets?query/', '/assets#fragment/', '/bad path/']) {
      expect(() => WebServer.Config({ ...baseConfig, immutablePathPrefixes: [invalid] })).toThrow()
    }
    expect(WebServer.Config({ ...baseConfig, immutablePathPrefixes: ['/assets/'] }).immutablePathPrefixes)
      .toEqual(['/assets/'])

    const defaultsContext = new Context()
    contexts.push(defaultsContext)
    const defaults = new WebServer(defaultsContext, { host: '127.0.0.1', port: 0 })
    await defaults[Service.init]()
    const defaultRuntime = state.servers.at(-1)
    if (defaultRuntime === undefined) throw new Error('default fake server was not created')

    expect(defaults.host).toBe('127.0.0.1')
    expect(defaults.port).toBe(43210)
    await dispatch(defaultRuntime, '/unclaimed', new MockResponse())
    expect(state.policyCalls[0]).toEqual({
      compression: { enabled: true, minBytes: 1024, brotliQuality: 5, gzipLevel: 6 },
      cache: { immutablePathPrefixes: ['/assets/'], immutableMaxAgeSeconds: 31_536_000 },
    })

    const tap = defaults.tapIndex(html => html)
    tap()
    tap()
    await defaultsContext.fiber.dispose()

    const context = new Context()
    contexts.push(context)
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => context.logger)
    const loggedErrors = vi.spyOn(context.logger, 'error').mockImplementation(() => context.logger)
    const configured = new WebServer(context, {
      host: '0.0.0.0',
      port: 4000,
      compress: false,
      compressMinBytes: 17,
      brotliQuality: 2,
      gzipLevel: 4,
      immutablePathPrefixes: ['/built/'],
      immutableMaxAgeSeconds: 60,
    })
    await configured[Service.init]()
    const runtime = state.servers.at(-1)
    if (runtime === undefined) throw new Error('configured fake server was not created')

    expect(configured.host).toBe('0.0.0.0')
    const deepDisposer = configured.register({
      kind: 'prefix',
      path: '/api/deep',
      handler: (_req, response) => { response.end('DEEP') },
    })
    configured.register({
      kind: 'prefix',
      path: '/api',
      handler: (_req, response) => { response.end('API') },
    })
    configured.register({
      kind: 'exact',
      path: '/api/deep/exact',
      handler: (_req, response) => { response.end('EXACT') },
    })
    configured.register({
      kind: 'exact',
      path: '/throws-string',
      handler: () => { throw 'route failure' },
    })
    configured.register({
      kind: 'exact',
      path: '/throws-after-headers',
      handler: (_req, response) => {
        response.writeHead(200)
        throw new Error('route failed after headers')
      },
    })
    expect(() => configured.register({
      kind: 'prefix',
      path: '/api',
      handler: () => {},
    })).toThrow(/duplicate prefix route/)
    expect(() => configured.register({
      kind: 'exact',
      path: '/api/deep/exact',
      handler: () => {},
    })).toThrow(/duplicate exact route/)
    const disposeWithoutFallback = configured.register({
      kind: 'exact',
      path: '/disposed',
      handler: () => {},
    })
    disposeWithoutFallback()

    const deep = new MockResponse()
    await dispatch(runtime, '/api/deep/leaf', deep)
    expect(deep.body).toBe('DEEP')
    const shorter = new MockResponse()
    await dispatch(runtime, '/api', shorter)
    expect(shorter.body).toBe('API')
    const exact = new MockResponse()
    await dispatch(runtime, '/api/deep/exact', exact)
    expect(exact.body).toBe('EXACT')
    deepDisposer()

    const fallbackDisposer = configured.registerFallback((_req, response) => { response.end('FALLBACK') })
    expect(() => configured.registerFallback(() => {})).toThrow(/fallback already registered/)
    const fallbackResponse = new MockResponse()
    await dispatch(runtime, '/not-registered', fallbackResponse)
    expect(fallbackResponse.body).toBe('FALLBACK')
    fallbackDisposer()
    const disposed = new MockResponse()
    await dispatch(runtime, '/disposed', disposed)
    expect(disposed.statusCode).toBe(404)

    context.on('webserver/index-inject', (table) => {
      table.push({ kind: 'html', placement: 'body', html: '<span>ROW</span>' })
    })
    const appendTap = configured.tapIndex(html => `${html}<!--TAP-->`)
    expect(configured.applyIndexTaps('raw')).toBe('raw<!--TAP-->')
    expect(configured.collectIndexInjections()).toEqual([
      { kind: 'html', placement: 'body', html: '<span>ROW</span>' },
    ])
    expect(configured.renderIndex('<html><head></head><body></body></html>'))
      .toContain('<span>ROW</span>')
    appendTap()

    const configuredPolicy = state.policyCalls.at(-1)
    expect(configuredPolicy).toEqual({
      compression: { enabled: false, minBytes: 17, brotliQuality: 2, gzipLevel: 4 },
      cache: { immutablePathPrefixes: ['/built/'], immutableMaxAgeSeconds: 60 },
    })

    const compressorFailure = new Error('compressor failed')
    state.policyErrors.push(compressorFailure)
    await dispatch(runtime, '/api', new MockResponse())
    expect(warn).toHaveBeenCalledWith(compressorFailure)

    const malformed = new MockResponse()
    await dispatch(runtime, 'http://[malformed', malformed)
    expect(malformed.statusCode).toBe(400)
    expect(malformed.headersSent).toBe(true)
    const stringFailure = new MockResponse()
    await dispatch(runtime, '/throws-string', stringFailure)
    expect(stringFailure.statusCode).toBe(400)
    const headersFailure = new MockResponse()
    await dispatch(runtime, '/throws-after-headers', headersFailure)
    expect(headersFailure.destroyed).toBe(true)
    expect(headersFailure.destroyCount).toBe(1)

    configured.registerUpgrade({ path: '/held', handler: () => {} })
    const disposeRawError = configured.registerUpgrade({ path: '/raw-error', handler: () => {} })
    expect(() => configured.registerUpgrade({ path: '/held', handler: () => {} }))
      .toThrow(/duplicate upgrade route/)
    configured.registerUpgrade({
      path: '/async-failure',
      handler: async () => { throw new Error('async upgrade failure') },
    })
    configured.registerUpgrade({
      path: '/async-value-failure',
      handler: async () => { throw 'async upgrade value failure' },
    })
    configured.registerUpgrade({
      path: '/sync-failure',
      handler: () => { throw 'sync upgrade failure' },
    })
    configured.registerUpgrade({
      path: '/sync-error-failure',
      handler: () => { throw new Error('sync upgrade error') },
    })

    const held = new MockSocket()
    await dispatchUpgrade(runtime, '/held', held)
    expect(held.destroyed).toBe(false)

    const socketError = new MockSocket()
    await dispatchUpgrade(runtime, '/raw-error', socketError)
    socketError.emit('error', new Error('raw socket failure'))
    expect(socketError.destroyed).toBe(true)
    disposeRawError()

    const malformedUpgrade = new MockSocket()
    await dispatchUpgrade(runtime, 'http://[malformed', malformedUpgrade)
    expect(malformedUpgrade.destroyed).toBe(true)
    const unmatched = new MockSocket()
    await dispatchUpgrade(runtime, '/not-registered', unmatched)
    expect(unmatched.destroyed).toBe(true)
    const syncFailure = new MockSocket()
    await dispatchUpgrade(runtime, '/sync-failure', syncFailure)
    expect(syncFailure.destroyed).toBe(true)
    const syncErrorFailure = new MockSocket()
    await dispatchUpgrade(runtime, '/sync-error-failure', syncErrorFailure)
    expect(syncErrorFailure.destroyed).toBe(true)
    const asyncFailure = new MockSocket()
    await dispatchUpgrade(runtime, '/async-failure', asyncFailure)
    expect(asyncFailure.destroyed).toBe(true)
    const asyncValueFailure = new MockSocket()
    await dispatchUpgrade(runtime, '/async-value-failure', asyncValueFailure)
    expect(asyncValueFailure.destroyed).toBe(true)

    const unstringifiable = new MockSocket()
    await dispatchUpgrade(runtime, { toString: () => { throw 'bad upgrade URL' } }, unstringifiable)
    expect(unstringifiable.destroyed).toBe(true)

    const serverFailure = new Error('post-listen server failure')
    runtime.emit('error', serverFailure)
    expect(loggedErrors).toHaveBeenCalledWith(serverFailure)

    await context.fiber.dispose()
    expect(runtime.closed).toBe(true)
    expect(runtime.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(held.destroyed).toBe(true)
  })
})

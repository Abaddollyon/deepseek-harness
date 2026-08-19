/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type ServerOptions } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

type Frame = MuxFrame | HostFrame

/** Smallest frame worth deflating; below it the deflate block costs more than it saves. */
export const DEFAULT_WEBSOCKET_COMPRESS_THRESHOLD = 1024

/** zlib's own default deflate level: the balanced point of its 0-9 range. */
export const DEFAULT_WEBSOCKET_COMPRESS_LEVEL = 6

/** Concurrent zlib operations across all downlink sockets, the ws project's documented cap. */
export const DEFAULT_WEBSOCKET_COMPRESS_CONCURRENCY_LIMIT = 10

/** permessage-deflate settings for the downlink sockets (RFC 7692). */
export interface WebSocketCompression {
  /** Whether the server offers the extension at all. */
  enabled: boolean
  /** Frames smaller than this are sent uncompressed. */
  threshold: number
  /** Deflate level, 0-9. */
  level: number
  /** Cap on concurrent zlib operations across every downlink socket. */
  concurrencyLimit: number
}

/**
 * Build the ws server's extension option.
 *
 * Context takeover stays on — the RFC 7692 default this server does not
 * override. The downlink carries one JSON envelope format over and over, so
 * the sliding window across frames is where most of the ratio comes from; the
 * cost is one zlib context per direction per socket, which a deployment that
 * cannot afford it removes by turning the extension off.
 * @param compression - the deployment's settings.
 * @returns the ws `perMessageDeflate` option, or false when the extension is disabled.
 */
function perMessageDeflate(compression: WebSocketCompression): ServerOptions['perMessageDeflate'] {
  if (!compression.enabled) return false
  return {
    threshold: compression.threshold,
    concurrencyLimit: compression.concurrencyLimit,
    zlibDeflateOptions: { level: compression.level },
  }
}

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function send(socket: WebSocket, frame: RpcRequest<Frame>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server: WebSocketServer
  private readonly pumps = new Set<Promise<void>>()

  /**
   * @param api - host API supplying the typed event streams.
   * @param compression - permessage-deflate settings for accepted sockets.
   */
  constructor(private readonly api: ApiProxy, compression: WebSocketCompression) {
    this.server = new WebSocketServer({
      noServer: true,
      perMessageDeflate: perMessageDeflate(compression),
    })
  }

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      websocket.once('close', () => { abort.abort() })
      websocket.once('error', () => { abort.abort() })
      websocket.once('message', () => {
        websocket.close(1008, 'downlink only')
      })
      const pump = this.pump(websocket, open(abort.signal), abort)
      this.pumps.add(pump)
      void pump.then(() => { this.pumps.delete(pump) })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) await send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error))
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}

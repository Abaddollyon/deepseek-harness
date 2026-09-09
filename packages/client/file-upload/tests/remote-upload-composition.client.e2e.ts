// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Blob as NodeBlob } from 'node:buffer'
import { load } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import * as environmentPlugin from '@deepseek-ai/dsh-client-environment-runtime/client'
import type { EnvironmentComposition } from '@deepseek-ai/dsh-client-environment-runtime/client'
import * as modulesPlugin from '@deepseek-ai/dsh-client-modules/client'
import type { ClientModuleLoaderTarget, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import * as rendererPlugin from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../../web/src/boot.ts'
import type {} from '../../web/src/runtime-activator.ts'
import * as uploadPlugin from '../src/client/index.ts'
import { createHostPlugin } from './fixtures/remote-upload/host-carrier.client.ts'
import { createConsumerPlugin } from './fixtures/remote-upload/upload-consumer.client.ts'

const CONNECTION = '@deepseek-ai/dsh-client-connection'
const ENVIRONMENT = '@deepseek-ai/dsh-client-environment-runtime'
const UPLOAD = '@deepseek-ai/dsh-client-file-upload'
const RENDERER = '@deepseek-ai/dsh-client-ui-renderer'
const HOST = './host-carrier.client.ts'
const CONSUMER = './upload-consumer.client.ts'
const SESSION = 'same-session' as SessionId

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function hostCarrier(id: string) {
  const generations: Array<{ ready(): void; drop(): void; signal: AbortSignal }> = []
  const received: Array<{ path: string; bytes: string }> = []
  let response: (() => Promise<Response>) | undefined
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    received.push({ path, bytes: await new Response(init?.body).text() })
    return response === undefined ? receipt(id) : response()
  })
  return { generations, received, request, setResponse(next?: () => Promise<Response>) { response = next } }
}

function receipt(id: string): Response {
  return Response.json({
    ok: true,
    value: { receiptId: `${id}-receipt`, file: { attachmentId: `${id}-file`, name: 'data.txt', bytes: 4 } },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

// The fake Host supplies the test-only cordis.yml graph and external carriers;
// AppWebEntry, module materialization, Loader, runtime activation and upload stay real.
it('keeps equal Session uploads on their Host and rejects reconnect-stale responses through Web boot', async () => {
  // Node's fetch reads Node Blob bytes; jsdom's Blob is not a fetch body.
  vi.stubGlobal('Blob', NodeBlob)
  const localFetch = vi.fn(() => { throw new Error('local upload fallback is forbidden') })
  vi.stubGlobal('__DSH_FILE_UPLOAD__', { fetch: localFetch })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const hosts = new Map(['alpha', 'beta'].map(id => [id, hostCarrier(id)]))
  let shell!: Context
  let composition: EnvironmentComposition | undefined
  const contexts = new Map<string, Context>()
  const receiptDisplay = createSnapshotStore('Ready')
  const response = deferred<Response>()
  const body = deferred<string>()
  const pending: Promise<unknown>[] = []
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.push(operation.then(() => undefined, () => undefined))
    return operation
  }
  const fallback = vi.fn(() => { throw new Error('encoded upload fallback is forbidden') })
  const exports = new Map<string, Record<string, unknown>>([
    [CONNECTION, connectionPlugin], [ENVIRONMENT, environmentPlugin],
    [UPLOAD, uploadPlugin], [RENDERER, rendererPlugin],
    [HOST, createHostPlugin(hosts, contexts, fallback)],
    [CONSUMER, createConsumerPlugin((ctx) => { shell = ctx }, receiptDisplay)],
  ])
  const config = load(await readFile(join(import.meta.dirname, 'fixtures/remote-upload/cordis.yml'), 'utf8')) as Array<{ name: string }>
  const dependencies: Record<string, string[]> = { [ENVIRONMENT]: [CONNECTION], [UPLOAD]: [HOST], [HOST]: [] }
  const entries = config.map(({ name }) => ({ id: name, url: `/${name}/client.js`, rev: 'test', inject: dependencies[name] ?? [] }))
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [],
    load(registration) { target.pendingQueue.push(registration) },
    create: options => modulesPlugin.createClientModuleSystem(target, {
      id: '@deepseek-ai/dsh-client-modules', exports: modulesPlugin,
    }, options),
  }
  vi.stubGlobal('__ModuleLoader__', target)
  vi.stubGlobal('__DSH_BOOT__', {
    rev: 'test', entries,
    batches: [{ phase: 'application', url: '/test-client.js', rev: 'test', entries: entries.map(row => row.id) }],
  } satisfies DshWindow['__DSH_BOOT__'])
  const container = document.createElement('div')
  document.body.append(container)
  const app = new AppWebEntry(container, {
    loadBundle: async () => {
      for (const [id, module] of exports) target.load({ id, factory: () => module })
    },
  })
  try {
    await app.run()
    expect(shell).toBeDefined()
    await vi.waitFor(() => { expect(container.textContent).toBe('Ready') })
    shell.environmentComposition.registerFactory(async (id) => {
      const host = hosts.get(id)
      if (host === undefined) throw new Error(`unknown Host ${id}`)
      return { request: host.request, connectionTransport: { fetch: localFetch }, dispose() {} }
    })
    composition = await shell.environmentComposition.start({
      navigation: shell.environmentNavigation,
      activator: shell.clientRuntimeActivator,
      domain: { roots: [UPLOAD] },
      presentation: { roots: [] }, suspension: { roots: [] },
      runtimeServices: ['fileUpload'], shellServices: [],
    })
    expect(shell.clientRuntimeActivator.deriveRoster([UPLOAD])).toContain(UPLOAD)
    const upload = async (id: string) => {
      const resolving = track(shell.environmentComposition.withPresentation({
        kind: 'session', ref: { environmentId: id, sessionId: SESSION }, viewId: 'chat',
      }, async ctx => ctx.fileUpload.upload(SESSION, new Blob(['data']), 'data.txt')))
      await vi.waitFor(() => { expect(hosts.get(id)!.generations).toHaveLength(1) })
      hosts.get(id)!.generations[0]!.ready()
      const result = await resolving
      expect(result).toMatchObject({ ok: true, value: { receiptId: `${id}-receipt` } })
      if (!result.ok) throw new Error('fixture upload failed')
      receiptDisplay.set(result.value.receiptId)
      await vi.waitFor(() => { expect(container.textContent).toBe(`${id}-receipt`) })
    }
    await upload('alpha')
    await upload('beta')
    for (const host of hosts.values()) {
      expect(host.received).toEqual([{ path: '/api/session/uploadFileBinary?sessionId=same-session&name=data.txt', bytes: 'data' }])
    }
    const beta = hosts.get('beta')!
    const context = contexts.get('beta')!
    const connection = context.get('connection') as ConnectionHandle
    beta.setResponse(() => response.promise)
    const stale = track(context.get('fileUpload')!.upload(SESSION, new Blob(['data']), 'data.txt'))
    await vi.waitFor(() => { expect(beta.received).toHaveLength(2) })
    connection.reconnect()
    await vi.waitFor(() => { expect(beta.generations).toHaveLength(2) })
    await expect(context.get('fileUpload')!.upload(SESSION, new Blob(['data']), 'data.txt'))
      .rejects.toThrow('Host is not connected')
    expect(beta.received).toHaveLength(2)
    beta.generations[1]!.ready()
    await vi.waitFor(() => { expect(connection.generation.getSnapshot()?.id).toBe(2) })
    response.resolve(receipt('stale'))
    await expect(stale).rejects.toThrow('Host generation changed before the response arrived')

    const readingBody = deferred<undefined>()
    beta.setResponse(async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        readingBody.resolve(undefined)
        controller.enqueue(new TextEncoder().encode(await body.promise))
        controller.close()
      },
    }, { highWaterMark: 0 })))
    const staleBody = track(context.get('fileUpload')!.upload(SESSION, new Blob(['data']), 'data.txt'))
    await readingBody.promise
    expect(beta.received).toHaveLength(3)
    connection.reconnect()
    await vi.waitFor(() => { expect(beta.generations).toHaveLength(3) })
    beta.generations[2]!.ready()
    await vi.waitFor(() => { expect(connection.generation.getSnapshot()?.id).toBe(3) })
    body.resolve(await receipt('stale-body').text())
    await expect(staleBody).rejects.toThrow(/generation changed/)
    expect(container.textContent).toBe('beta-receipt')
    beta.setResponse()
    await expect(context.get('fileUpload')!.upload(SESSION, new Blob(['data']), 'data.txt'))
      .resolves.toMatchObject({ ok: true, value: { receiptId: 'beta-receipt' } })
    expect(hosts.get('alpha')!.received).toHaveLength(1)
    expect(localFetch).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  } finally {
    response.resolve(receipt('cleanup'))
    body.resolve(await receipt('cleanup').text())
    try {
      await composition?.dispose()
    } finally {
      try {
        await app.dispose()
      } finally {
        await Promise.all(pending)
      }
    }
  }
  expect([...hosts.values()].flatMap(host => host.generations).every(generation => generation.signal.aborted)).toBe(true)
})

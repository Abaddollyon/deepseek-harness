import { describe, expect, test, vi } from 'vitest'
import { createEnvironmentRequest } from '../src/client/request.ts'

describe('environment request', () => {
  test('binds the environment and permits registered relative feature routes', async () => {
    const carrier = vi.fn(async () => new Response('ok'))
    const client = createEnvironmentRequest({
      environmentId: 'sigil',
      registeredRoutes: ['/api/tasks', '/api/automations'],
      request: carrier,
    })

    await client.request('/api/tasks?projection=summary', { method: 'GET' })

    expect(carrier).toHaveBeenCalledWith(
      'sigil',
      '/api/tasks?projection=summary',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    )
  })

  test.each([
    'https://remote.invalid/api/tasks',
    '//remote.invalid/api/tasks',
    '/api/tasks/../settings',
    '/api/not-registered',
  ])('rejects an untrusted target %s', async (path) => {
    const client = createEnvironmentRequest({
      environmentId: 'local',
      registeredRoutes: ['/api/tasks'],
      request: vi.fn(),
    })
    await expect(client.request(path)).rejects.toThrow('environment request')
  })

  test('rejects a response from an obsolete host generation', async () => {
    let generation = 1
    let finish!: (response: Response) => void
    const client = createEnvironmentRequest({
      environmentId: 'sigil',
      registeredRoutes: ['/api/tasks'],
      generation: () => generation,
      request: () => new Promise((resolve) => { finish = resolve }),
    })

    const response = client.request('/api/tasks')
    generation = 2
    finish(new Response('late'))

    await expect(response).rejects.toThrow('generation changed')
  })

  test('does not send while the Host has no ready generation', async () => {
    const carrier = vi.fn(async () => new Response('should-not-send'))
    const client = createEnvironmentRequest({
      environmentId: 'sigil',
      registeredRoutes: ['/api/tasks'],
      generation: () => undefined,
      request: carrier,
    })

    await expect(client.request('/api/tasks', { method: 'POST' })).rejects.toThrow('not connected')
    expect(carrier).not.toHaveBeenCalled()
  })

  test('aborts outstanding requests when disposed', async () => {
    let signal!: AbortSignal
    const client = createEnvironmentRequest({
      environmentId: 'sigil',
      registeredRoutes: ['/api/tasks'],
      request: (_environmentId, _path, init) => {
        signal = init.signal as AbortSignal
        return new Promise(() => {})
      },
    })

    void client.request('/api/tasks')
    client.dispose()

    expect(signal.aborted).toBe(true)
    await expect(client.request('/api/tasks')).rejects.toThrow('disposed')
  })

  test('route registration follows the registering plugin lifetime', async () => {
    const client = createEnvironmentRequest({
      environmentId: 'local',
      request: async () => new Response('ok'),
    })
    const unregister = client.registerRoute('/api/tasks')

    await expect(client.request('/api/tasks')).resolves.toBeInstanceOf(Response)
    unregister()
    await expect(client.request('/api/tasks')).rejects.toThrow('not registered')
  })
})

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import {
  createActiveEnvironmentRuntimeProjection,
  createEnvironmentPresentationMount,
  createEnvironmentRuntimeRegistry,
  type EnvironmentRuntime,
  type EnvironmentSelectionSource,
} from '@deepseek-ai/dsh-client-environment-runtime/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'

function selection(initial: string): EnvironmentSelectionSource & { set(value: string): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(value) { current = value; for (const listener of [...listeners]) listener() },
  }
}

function runtime(environmentId: string): EnvironmentRuntime {
  const context = new Context()
  for (const name of ['sessions', 'remote', 'workspaces', 'settingsScope']) {
    context.reflect.provide(name, { environmentId, name })
  }
  context.reflect.provide('remote.settings', { environmentId, name: 'remote.settings' })
  return {
    environmentId,
    runtimeId: `${environmentId}-runtime`,
    context,
    request: { request: vi.fn(), registerRoute: vi.fn(() => () => {}), dispose: vi.fn() },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    dispose: async () => { await context.fiber.dispose() },
  }
}

describe('selected runtime presentation integration', () => {
  test('projects four owning-runtime service faces through one shell SlotRegistry', async () => {
    const shell = new Context()
    await shell.plugin(SlotRegistry).await()
    const slots = shell.slots
    slots.register({ name: 'root', children: { 'active.content': { kind: 'list', scope: 'root' } } } as never, () => null)
    const selected = selection('local')
    const contexts = new Map<string, Context>()
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async (id) => {
      const value = runtime(id); contexts.set(id, value.context); return value
    } })
    const observed: Array<Record<string, string>> = []
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate: async (owner, signal) => {
        const mount = await createEnvironmentPresentationMount({
          runtime: owner,
          shell,
          signal,
          runtimeServices: ['sessions', 'remote', 'remote.settings', 'workspaces', 'settingsScope'],
          shellServices: ['slots'],
          activate: (ctx) => {
            observed.push(Object.fromEntries(['sessions', 'remote', 'workspaces', 'settingsScope'].map(name => [
              name, (ctx.get(name) as { environmentId: string }).environmentId,
            ])))
            expect((ctx.get('remote.settings') as { environmentId: string }).environmentId).toBe(owner.environmentId)
            return ctx.slots.register({ name: 'active.content', id: `runtime-${owner.environmentId}` }, () => null)
          },
        })
        return () => mount.dispose()
      },
    })
    await projection.whenIdle()
    selected.set('sigil')
    await projection.whenIdle()

    expect(slots.entries('active.content').map(entry => entry.options.id)).toEqual(['runtime-sigil'])
    expect(observed).toEqual([
      { sessions: 'local', remote: 'local', workspaces: 'local', settingsScope: 'local' },
      { sessions: 'sigil', remote: 'sigil', workspaces: 'sigil', settingsScope: 'sigil' },
    ])
    expect(contexts.get('local') === contexts.get('sigil')).toBe(false)
    await projection.dispose()
    expect(slots.entries('active.content')).toHaveLength(0)
    await shell.fiber.dispose()
  })
})

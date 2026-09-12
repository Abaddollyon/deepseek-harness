/**
 * The plugin's wiring, and its removal when the plugin goes.
 *
 * The registry and the navigation controller are real, because "provided"
 * means what those faces do; the slot, locale, frame, and resource faces are
 * recorders, because what matters here is what was handed to them — two seats
 * over one store, the guide's body under its own id, the frame reports, the
 * service binding — and that every registration is gone after dispose, which
 * is what makes a reload safe. The seats' components have their own specs.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { GuideInjected, SidebarRightInjected } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { SidebarRightController, type SurfaceActions } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'
import { RightbarSeat } from '../src/client/shell/SidebarRight.tsx'
import { ExpandButton } from '../src/client/shell/ExpandButton.tsx'
import { GuideBody } from '../src/client/tabs/guide/GuideBody.tsx'
import { GUIDE_ID } from '../src/client/tabs/guide/definition.ts'
import { en, zh } from '../src/client/locales.ts'

const SESSION = 's-test' as SessionId

interface Recorded {
  name: string
  key?: string
  locale: string
  store?: unknown
  children?: unknown
  inject?: (sessionId: SessionId, actions?: SurfaceActions) => unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() }
  const resources = { pin: vi.fn<(address: string, signal: AbortSignal) => void>() }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('layout', layout as never)
  ctx.provide('resources', resources as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const seat = (name: string): Recorded => {
    const entry = registered.find(candidate => candidate.name === name)
    if (entry === undefined) throw new Error(`expected a registration into ${name}`)
    return entry
  }
  const injectedOf = (entry: Recorded, actions?: SurfaceActions, sessionId = SESSION): unknown => {
    if (entry.inject === undefined) throw new Error(`expected ${entry.name} to inject`)
    return entry.inject(sessionId, actions)
  }
  return { ctx, registered, dictionaries, layout, resources, fiber, seat, injectedOf }
}

describe('ui-sidebar-right apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('provides both faces, and registers the guide through the same two-stage path as any other type', async () => {
    const { ctx, registered, dictionaries, seat } = await boot()
    expect(ctx.sidebarRightTabs).toBeInstanceOf(SidebarRightTabRegistry)
    expect(ctx.sidebarRight).toBeInstanceOf(SidebarRightController)
    expect('adopt' in ctx.sidebarRight).toBe(false)
    expect(dictionaries.get('sidebarRight')).toEqual({ zh, en })
    const guide = ctx.sidebarRightTabs.get('guide')
    expect(guide?.id).toBe(GUIDE_ID)
    expect(guide?.priority).toBe('builtin')
    expect(guide?.title('sidebar://guide')).toBe('tab.guide.title')
    // Three registrations: the panel seat, the header's corner seat, and the
    // guide body under the guide implementation's id.
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['rightbar', undefined, 'sidebarRight', RightbarSeat],
      ['conversation.session.header.corner', undefined, 'sidebarRight', ExpandButton],
      ['sidebar.right.pane.tab', GUIDE_ID, 'sidebarRight', GuideBody],
    ])
    // The panel declares the extension seats; the guide declares its chain child.
    expect(Object.keys(seat('rightbar').children as object)).toEqual([
      'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'sidebar.right.tab.menu.item',
    ])
    expect(seat('sidebar.right.pane.tab').children).toMatchObject({ 'sidebar.right.tab.guide': { kind: 'chain', scope: 'session' } })
    // Both seats read one store: the button only needs to know whether the panel is expanded.
    expect(seat('rightbar').store).toBeDefined()
    expect(seat('conversation.session.header.corner').store).toBe(seat('rightbar').store)
  })

  it('hands the panel seat the frame report, the service binding, the opens, the observable registry, and the Tab domain', async () => {
    const { ctx, layout, resources, seat, injectedOf } = await boot()
    const handle = seat('rightbar').store as ReturnType<typeof createSidebarRightStore>
    const instance = handle.create()
    const injected = injectedOf(seat('rightbar'), instance.actions) as SidebarRightInjected
    // The frame learns the composition of expanded and presentation, nothing else.
    injected.syncPresentation({ shown: true, track: true, fullscreen: false })
    expect(layout.openRightbar).toHaveBeenLastCalledWith(true, false)
    injected.syncPresentation({ shown: true, track: true, fullscreen: true })
    expect(layout.openRightbar).toHaveBeenLastCalledWith(true, true)
    injected.syncPresentation({ shown: true, track: false, fullscreen: true })
    expect(layout.openRightbar).toHaveBeenLastCalledWith(false, true)
    injected.syncPresentation({ shown: false, track: false, fullscreen: false })
    expect(layout.closeRightbar).toHaveBeenCalledOnce()
    // The registry, observable: what the seat dispatches a kind to.
    expect(injected.hooks.tabTypes.getSnapshot().find(type => type.kind === 'guide')?.id).toBe(GUIDE_ID)
    const seen = vi.fn()
    const unsubscribe = injected.hooks.tabTypes.subscribe(seen)
    ctx.sidebarRightTabs.register({ id: 'spec/text', kind: 'text', patterns: ['dsh-resource://file/**'], title: () => 'text' })
    expect(seen).toHaveBeenCalledOnce()
    unsubscribe()
    // The binding makes the service act on this seat's session.
    const release = injected.bindService({ sessionId: SESSION, actions: instance.actions, surfaces: {}, canSplitPane: () => true })
    injected.openTab('guide', { revealIfOpened: false })
    const surface = instance.getSnapshot().bySession[SESSION]
    expect(surface?.layout.expanded).toBe(true)
    expect(Object.values(surface?.layout.tabs ?? {}).map(tab => tab.kind)).toEqual(['guide'])
    // The committed record pins its address through the resource model.
    expect(resources.pin).toHaveBeenCalledWith('sidebar://guide', expect.any(AbortSignal))
    release()
    expect(() => { ctx.sidebarRight.toggleExpanded() }).toThrow('no session surface is mounted')
  })

  it('adopts the native injected session rather than the opaque store key before the first commit', async () => {
    const { ctx, resources, seat, injectedOf } = await boot()
    const handle = seat('rightbar').store as ReturnType<typeof createSidebarRightStore>
    expect(seat('conversation.session.header.corner').store).toBe(handle)
    const instance = handle.create('["host-a","s-test"]')
    injectedOf(seat('rightbar'), instance.actions)
    expect(resources.pin).not.toHaveBeenCalled()
    instance.actions.open(SESSION)
    const guide = Object.values(instance.getSnapshot().bySession[SESSION]?.layout.tabs ?? {})[0]
    if (guide === undefined) throw new Error('expected the seeded guide')
    // Held and pinned from the store's own commit: no seat synced anything.
    const occurrence = ctx.sidebarRight.tabDomain.occurrence(SESSION, guide)
    expect(resources.pin).toHaveBeenCalledWith('sidebar://guide', occurrence.signal)
    occurrence.tabActions.close()
    expect(instance.getSnapshot().bySession[SESSION]?.layout.tabs[guide.id]).toBeUndefined()
    expect(occurrence.signal.aborted).toBe(true)
  })

  it('adopts from the header before the panel and retains the same committed occurrence on reinjection', async () => {
    const { ctx, resources, seat, injectedOf } = await boot()
    const handle = seat('conversation.session.header.corner').store as ReturnType<typeof createSidebarRightStore>
    const instance = handle.create('opaque-header-store')
    injectedOf(seat('conversation.session.header.corner'), instance.actions)
    instance.actions.open(SESSION)
    const guide = Object.values(instance.getSnapshot().bySession[SESSION]!.layout.tabs)[0]!
    const occurrence = ctx.sidebarRight.tabDomain.occurrence(SESSION, guide)

    const injected = injectedOf(seat('rightbar'), instance.actions) as SidebarRightInjected
    expect(injected.occurrence(guide)).toBe(occurrence)
    expect(injected.keyedHooks.tabNavigation(guide.id)).toBe(occurrence.navigation)
    instance.actions.open(SESSION)
    expect(resources.pin).toHaveBeenCalledOnce()
    occurrence.tabActions.close()
    expect(occurrence.signal.aborted).toBe(true)
  })

  it('hands the guide body the registry\'s entry boxes, observable', async () => {
    const { ctx, seat, injectedOf } = await boot()
    const { hooks: { guideEntries } } = injectedOf(seat('sidebar.right.pane.tab')) as GuideInjected
    expect(guideEntries.getSnapshot()).toEqual([])
    const seen = vi.fn()
    guideEntries.subscribe(seen)
    ctx.sidebarRightTabs.register({
      id: 'spec/files',
      kind: 'files',
      title: () => 'Files',
      guide: [{ order: 10, title: () => 'Files', description: () => 'The workspace tree' }],
    })
    expect(seen).toHaveBeenCalledOnce()
    expect(guideEntries.getSnapshot().map(entry => entry.kind)).toEqual(['files'])
  })

  it('takes every registration and both faces back when disposed, aborting the open records, so a reload registers again', async () => {
    const { ctx, registered, dictionaries, fiber, seat, injectedOf } = await boot()
    const handle = seat('rightbar').store as ReturnType<typeof createSidebarRightStore>
    const instance = handle.create('["host-a","s-test"]')
    const injected = injectedOf(seat('rightbar'), instance.actions) as SidebarRightInjected
    // A materialized but uninjected store has no subscription to release.
    handle.create('unrendered')
    injected.bindService({ sessionId: SESSION, actions: instance.actions, surfaces: {}, canSplitPane: () => true })
    injected.openTab('guide')
    const surface = instance.getSnapshot().bySession[SESSION]
    const guide = Object.values(surface?.layout.tabs ?? {})[0]
    if (guide === undefined) throw new Error('expected the guide tab')
    const { signal, tabActions } = ctx.sidebarRight.tabDomain.occurrence(SESSION, guide)
    await fiber.dispose()
    expect(signal.aborted).toBe(true)
    // The adoption went with the plugin: a late action from the dead occurrence changes nothing.
    tabActions.close()
    expect(instance.getSnapshot().bySession[SESSION]?.layout.tabs[guide.id]).toBeDefined()
    expect(ctx.get('sidebarRight')).toBeUndefined()
    expect(ctx.get('sidebarRightTabs')).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(ctx.sidebarRightTabs.get('guide')?.id).toBe(GUIDE_ID)
    expect(registered).toHaveLength(3)
  })
})

// @vitest-environment jsdom
/** Native tab ownership through environment-scoped Session adapters and the real slot renderer. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSlotRenderer, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applySession, inject as sessionInject } from '@deepseek-ai/dsh-client-ui-session/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 'same-native-session' as SessionId
const contexts: Context[] = []

afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) await act(() => ctx.fiber.dispose())
})

async function mountHost(environmentId: string) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('environmentRuntime', { environmentId } as never)
  await ctx.plugin(SlotRegistry).await()
  const sessions = new TestSessions(async (fn) => { await act(fn) }, ctx)
  ctx.provide('sessions', sessions)
  await sessions.add({ id: SESSION })
  await ctx.plugin({ inject: [...sessionInject], apply: applySession }).await()
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  ctx.provide('resources', { pin } as never)
  ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.slots.installLocale(locale)
  const renderer = createSlotRenderer()
  let host: SlotRendererHost | undefined
  ctx.slots.install({
    renderRoot: (value, owner) => {
      host = value
      return renderer.renderRoot(value, owner)
    },
  })
  ctx.slots.register({
    name: 'root',
    children: {
      'rightbar': { kind: 'single', scope: 'session' },
      'conversation.session.header.corner': { kind: 'single', scope: 'session' },
    },
  }, ({ renderSlot }) => <>
    {renderSlot('conversation.session.header.corner', {})}
    {renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })}
  </>)
  const feature = ctx.plugin({ inject: [...inject], apply })
  await feature.await()
  const view = render(ctx.slots.renderSlot('root', {}))
  const binding = ctx.uiSession.adapter.resolve(SESSION)!
  const entry = host!.entriesOf('rightbar')[0]!
  const instance = host!.storeOf(entry, binding) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
  const guide = Object.values(instance.getSnapshot().bySession[SESSION]!.layout.tabs)[0]!
  const occurrence = ctx.sidebarRight.tabDomain.occurrence(SESSION, guide)
  return { ctx, sessions, feature, view, binding, instance, guide, occurrence, pin }
}

describe('Sidebar Host Session ownership', () => {
  it('keeps equal native Session and tab ids independent across Host compositions', async () => {
    const first = await mountHost('host-a')
    const second = await mountHost('host-b')
    expect(first.binding).toMatchObject({ key: SESSION, storeKey: '["host-a","same-native-session"]' })
    expect(second.binding).toMatchObject({ key: SESSION, storeKey: '["host-b","same-native-session"]' })
    expect(first.instance).not.toBe(second.instance)
    expect(first.guide.id).toBe(second.guide.id)
    expect(first.occurrence).not.toBe(second.occurrence)
    expect(first.pin).toHaveBeenCalledWith('sidebar://guide', first.occurrence.signal)
    expect(second.pin).toHaveBeenCalledWith('sidebar://guide', second.occurrence.signal)
    expect(first.view.container.querySelector('[data-sidebar-right-panel]')).not.toBeNull()
    expect(second.view.container.querySelector('[data-sidebar-right-panel]')).not.toBeNull()

    const untouched = second.instance.getSnapshot()
    act(() => { first.occurrence.tabActions.close() })
    expect(first.occurrence.signal.aborted).toBe(true)
    expect(second.occurrence.signal.aborted).toBe(false)
    expect(second.instance.getSnapshot()).toBe(untouched)

    await act(() => first.feature.dispose())
    act(() => { second.occurrence.tabActions.close() })
    expect(second.occurrence.signal.aborted).toBe(true)
    expect(second.instance.getSnapshot().bySession[SESSION]!.layout.tabs[second.guide.id]).toBeUndefined()
  })
})

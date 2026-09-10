// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  createEnvironmentNavigation, createEnvironmentPresentationStore,
} from '@deepseek-ai/dsh-client-environment-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import {
  ActivityContent, ActivityToggle, EnvironmentFooterAction, EnvironmentOverview,
} from '../src/client/EnvironmentNavigation.tsx'

describe('environment navigation UI seats', () => {
  test('uses accessible SVG controls for Activity and Environments', () => {
    let mode: 'workspaces' | 'activity' = 'workspaces'
    const setMode = (next: typeof mode) => { mode = next }
    const t = (key: string) => key === 'activity' ? 'Activity' : 'Environments'
    const activityProps = {
      wide: true,
      expandSidebar: () => {},
      useSidebarMode: (selector: (value: typeof mode) => unknown) => selector(mode),
      setMode,
      t,
    } as unknown as Parameters<typeof ActivityToggle>[0]
    const first = render(<ActivityToggle {...activityProps} />)
    const bell = screen.getByRole('button', { name: 'Activity' })
    expect(bell.getAttribute('aria-pressed')).toBe('false')
    expect(bell.querySelector('svg[data-icon="bell"]')).not.toBeNull()
    fireEvent.click(bell)
    expect(mode).toBe('activity')
    first.unmount()

    const footerProps = { wide: true, openOverview: () => {}, t } as unknown as Parameters<typeof EnvironmentFooterAction>[0]
    render(<EnvironmentFooterAction {...footerProps} />)
    expect(screen.getByRole('button', { name: 'Environments' }).querySelector('svg[data-icon="server"]')).not.toBeNull()
  })

  test('registers overview and Activity below the existing shell', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.slots
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('uiSidebar', {})
    ctx.provide('environmentNavigation', {
      ...createEnvironmentNavigation({ kind: 'environments' }),
      presentation: createEnvironmentPresentationStore(),
    })
    slots.register({
      name: 'root',
      children: {
        'active.content': { kind: 'list', scope: 'root' },
        'sidebar.workspace.section': { kind: 'list', scope: 'root' },
        'sidebar.workspaces.header.action': { kind: 'list', scope: 'root' },
        'sidebar.workspaces.content.overlay': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    const navigation = ctx.environmentNavigation
    const toggle = slots.entries('sidebar.workspaces.header.action')[0]!.inject!({} as never) as {
      hooks: { sidebarMode: { getSnapshot(): string; subscribe(listener: () => void): () => void } }
      setMode(mode: 'activity' | 'workspaces'): void
    }
    const content = slots.entries('sidebar.workspaces.content.overlay')[0]!.inject!({} as never) as typeof toggle
    const footer = slots.entries('sidebar.footer.action')[0]!.inject!({} as never) as { openOverview(): void }
    const overview = slots.entries('active.content')[0]!.inject!({} as never) as { hooks: { environmentLocation: unknown } }
    expect(overview.hooks.environmentLocation).toBe(navigation)
    const changed = vi.fn()
    const off = toggle.hooks.sidebarMode.subscribe(changed)
    expect(toggle.hooks.sidebarMode.getSnapshot()).toBe('workspaces')
    toggle.setMode('activity')
    expect(toggle.hooks.sidebarMode.getSnapshot()).toBe('activity')
    navigation.open({ kind: 'session', ref: { environmentId: 'remote', sessionId: 'same' }, viewId: 'chat' })
    expect(toggle.hooks.sidebarMode.getSnapshot()).toBe('workspaces')
    content.setMode('activity')
    navigation.open({ kind: 'new-session', environmentId: 'local', viewId: 'chat' })
    footer.openOverview()
    expect(navigation.getSnapshot()).toEqual({ kind: 'environments', selectedId: 'local' })
    navigation.open({ kind: 'new-session', environmentId: 'remote', viewId: 'chat' })
    footer.openOverview()
    expect(navigation.getSnapshot()).toEqual({ kind: 'environments', selectedId: 'remote' })
    off()
    changed.mockClear()
    content.setMode('workspaces')
    expect(changed).not.toHaveBeenCalled()

    expect(slots.spec('environment.overview.content')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('sidebar.activity')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.entries('active.content').some(entry => entry.options.id === 'environment-overview')).toBe(true)
    expect(slots.entries('sidebar.workspaces.header.action')).toHaveLength(1)
    expect(slots.entries('sidebar.workspaces.content.overlay')).toHaveLength(1)
    expect(slots.entries('sidebar.footer.action').some(entry => entry.options.id === 'environments')).toBe(true)
    await ctx.fiber.dispose()
  })
})

test('expanded and rail modes expose both labeled destinations and the selected mode', () => {
  let mode: 'workspaces' | 'activity' = 'workspaces'
  let expanded = 0
  const props = {
    wide: true,
    expandSidebar: () => { expanded++ },
    useSidebarMode: (select: (value: typeof mode) => unknown) => select(mode),
    setMode: (next: typeof mode) => { mode = next },
    t: (key: string) => ({ workspaces: 'Workspaces', activity: 'Activity', 'sidebar.mode': 'Sidebar mode' })[key],
  } as unknown as Parameters<typeof ActivityToggle>[0]
  const view = render(<ActivityToggle {...props} />)
  const snapshot = () => [...view.container.querySelectorAll('button')].map(button => ({
    label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed'), text: button.textContent,
  }))
  expect(snapshot()).toMatchInlineSnapshot(`
    [
      {
        "label": "Workspaces",
        "pressed": "true",
        "text": "Workspaces",
      },
      {
        "label": "Activity",
        "pressed": "false",
        "text": "Activity",
      },
    ]
  `)
  fireEvent.click(view.getByRole('button', { name: 'Activity' }))
  view.rerender(<ActivityToggle {...props} wide={false} />)
  expect(snapshot()).toMatchInlineSnapshot(`
    [
      {
        "label": "Workspaces",
        "pressed": "false",
        "text": "",
      },
      {
        "label": "Activity",
        "pressed": "true",
        "text": "",
      },
    ]
  `)
  fireEvent.click(view.getByRole('button', { name: 'Workspaces' }))
  expect(mode).toBe('workspaces')
  expect(expanded).toBe(1)
  view.unmount()
})

describe('environment navigation component behavior', () => {
  afterEach(() => { vi.restoreAllMocks() })

  test('renders overview fallback only for the environments location', async () => {
    const locations = [
      { kind: 'environments' as const, selectedId: 'local' },
      { kind: 'session' as const, ref: { environmentId: 'local', sessionId: 's1' }, viewId: 'chat' },
    ]
    const props = (location: typeof locations[number]) => ({
      useEnvironmentLocation: (select: (value: typeof location) => unknown) => select(location),
      renderSlot: (_name: string, _owner: unknown, options?: { fallback?: unknown }) => options?.fallback,
      t: (key: string) => key,
    } as unknown as Parameters<typeof import('../src/client/EnvironmentNavigation.tsx').EnvironmentOverview>[0])
    expect(locations).toHaveLength(2)
    const view = render(<EnvironmentOverview {...props(locations[0]!)} />)
    expect(screen.getByRole('heading', { name: 'overview.title' })).toBeTruthy()
    view.rerender(<EnvironmentOverview {...props(locations[1]!)} />)
    expect(screen.queryByRole('heading', { name: 'overview.title' })).toBeNull()
    view.unmount()
  })

  test('hides Activity content outside Activity mode and restores the underlying region on unmount', () => {
    let mode: 'workspaces' | 'activity' = 'workspaces'
    const setUnderlyingHidden = vi.fn()
    const renderSlot = vi.fn(() => <div>activity row</div>)
    const props = {
      wide: false,
      expandSidebar: vi.fn(),
      useSidebarMode: (select: (value: typeof mode) => unknown) => select(mode),
      setMode: vi.fn(),
      setUnderlyingHidden,
      renderSlot,
    } as unknown as Parameters<typeof import('../src/client/EnvironmentNavigation.tsx').ActivityContent>[0]
    const view = render(<ActivityContent {...props} />)
    expect(screen.queryByText('activity row')).toBeNull()
    expect(setUnderlyingHidden).toHaveBeenLastCalledWith(false)
    mode = 'activity'
    view.rerender(<ActivityContent {...props} />)
    expect(screen.getByText('activity row')).toBeTruthy()
    expect(setUnderlyingHidden).toHaveBeenLastCalledWith(true)
    view.unmount()
    expect(setUnderlyingHidden).toHaveBeenLastCalledWith(false)
  })

  test('footer action opens overview in the rail without rendering copy', () => {
    const openOverview = vi.fn()
    const props = { wide: false, openOverview, t: (key: string) => key } as unknown as Parameters<typeof EnvironmentFooterAction>[0]
    const view = render(<EnvironmentFooterAction {...props} />)
    const button = screen.getByRole('button', { name: 'environments' })
    expect(button.textContent).toBe('')
    fireEvent.click(button)
    expect(openOverview).toHaveBeenCalledOnce()
    view.unmount()
  })
})

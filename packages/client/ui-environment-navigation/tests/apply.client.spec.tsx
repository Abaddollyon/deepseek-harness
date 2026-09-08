// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  createEnvironmentNavigation, createEnvironmentPresentationStore,
} from '@deepseek-ai/dsh-client-environment-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { ActivityToggle, EnvironmentFooterAction } from '../src/client/EnvironmentNavigation.tsx'

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

    await ctx.plugin({ apply, inject }).await()

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

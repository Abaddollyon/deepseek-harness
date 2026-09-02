// @vitest-environment jsdom
/** External sidebar sections compose and dispose through the declared list slot. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SidebarSectionOwnerProps } from '../src/client/contract/slots.ts'

afterEach(() => { cleanup() })

/** Register a third-party remote-SSH section without depending on sidebar internals. */
function applyRemoteSection(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.workspace.section', () => ctx.slots.register(
    { name: 'sidebar.workspace.section', id: 'remote-ssh' },
    ({ wide }: SidebarSectionOwnerProps) => <button type="button">{wide ? 'Remote SSH' : 'SSH'}</button>,
  ))
}

describe('external sidebar workspace sections', () => {
  it('composes a declaration-aware remote section and removes it on HMR disposal', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.ctx.provide('layout', { toggleSidebar: vi.fn() })
    runtime.ctx.provide('uiWorkspace', { startSession: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.declare({ 'sidebar': { kind: 'single', scope: 'root' } })

    const remoteSection = runtime.ctx.plugin({
      name: 'remote-ssh-section',
      inject: ['slots'],
      apply: applyRemoteSection,
    })
    await remoteSection.await()
    await runtime.mount({ inject: [...inject], apply })

    const sidebar = runtime.renderSlot('sidebar', { collapsed: false, width: 300 })
    expect(sidebar.view.getByRole('button', { name: 'Remote SSH' })).toBeTruthy()
    expect(runtime.slots.entries('sidebar.workspace.section')).toHaveLength(1)

    await remoteSection.dispose()
    expect(sidebar.view.queryByRole('button', { name: 'Remote SSH' })).toBeNull()
    expect(runtime.slots.entries('sidebar.workspace.section')).toHaveLength(0)

    await runtime.dispose()
  })

  it('tracks pointer movement inside and outside the sidebar box', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.ctx.provide('layout', { toggleSidebar: vi.fn() })
    runtime.ctx.provide('uiWorkspace', { startSession: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.declare({ sidebar: { kind: 'single', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    const sidebar = runtime.renderSlot('sidebar', { collapsed: false, width: 300 })
    const root = sidebar.container.firstElementChild as HTMLDivElement
    root.getBoundingClientRect = () => ({
      left: 0, right: 300, top: 0, bottom: 600, width: 300, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerEnter(root)
    fireEvent.pointerMove(document, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(document, { clientX: 500, clientY: 100 })
    fireEvent.pointerLeave(root)
    await runtime.dispose()
  })
})

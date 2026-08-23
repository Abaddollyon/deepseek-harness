// @vitest-environment jsdom
/** External sidebar sections compose and dispose through the declared list slot. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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
    runtime.provide('layout', { toggleSidebar: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
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
})

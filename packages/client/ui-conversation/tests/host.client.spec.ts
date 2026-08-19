import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CONVERSATION_SETTINGS_NAMESPACE, Config, DEFAULT_BUSY_ENTER_BEHAVIOR,
  RENDERING_SETTINGS_NAMESPACE, apply,
} from '@deepseek-ai/dsh-client-ui-conversation'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-conversation host', () => {
  it('registers, validates, and disposes the durable busy-Enter preference', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply, Config })
    await fiber.await()
    const ns = settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual({ busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR })
    await ctx.settings.update(ns, { busyEnter: 'steer' })
    expect(ctx.settings.get(ns)).toEqual({ busyEnter: 'steer' })
    await expect(ctx.settings.update(ns, { busyEnter: 'invalid' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('publishes the deployment render bounds as the rendering section base layer', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply, Config }, { rendering: { highlightMaxChars: 2_048 } })
    await fiber.await()
    const ns = settingsNamespace(RENDERING_SETTINGS_NAMESPACE)
    // The browser half applies only the fields present; ui-primitives owns the
    // built-in value every omitted field keeps.
    expect(ctx.settings.get(ns)).toEqual({ highlightMaxChars: 2_048 })
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('leaves every render bound to its built-in value when the deployment sets none', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply, Config })
    await fiber.await()
    expect(ctx.settings.get(settingsNamespace(RENDERING_SETTINGS_NAMESPACE))).toEqual({})
    await fiber.dispose()
  })

  it('refuses a highlight cap that would disable highlighting outright', () => {
    expect(() => new Config({ rendering: { highlightMaxChars: 0 } })).toThrow()
  })
})

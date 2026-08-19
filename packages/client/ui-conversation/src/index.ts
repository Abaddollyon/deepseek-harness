/** Host registration for browser conversation preferences and render bounds. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CONVERSATION_SETTINGS_NAMESPACE, ConversationSettingsSchema } from './submission-settings.ts'
import {
  ConversationRenderingSettingsSchema, RENDERING_SETTINGS_NAMESPACE,
  type ConversationRenderingSettings,
} from './rendering-settings.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

export {
  ConversationRenderingSettingsSchema, RENDERING_SETTINGS_NAMESPACE,
  type ConversationRenderingSettings,
} from './rendering-settings.ts'

/**
 * Plugin config: the deployment's conversation render bounds. Each field
 * becomes the base layer of the `ui-conversation-rendering` settings
 * namespace, which is how a host-plane value reaches the browser half; an
 * omitted field leaves the browser's built-in bound in place.
 */
export interface ConversationHostConfig {
  /** Render bounds published to the browser half. */
  rendering: ConversationRenderingSettings
}

export const Config: z<ConversationHostConfig> = z.object({
  rendering: ConversationRenderingSettingsSchema.default({}),
})

/**
 * Register the durable conversation sections when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the sections.
 * @param config - Deployment render bounds published as the rendering section's base layer.
 */
export function apply(ctx: Context, config: ConversationHostConfig): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE),
      ConversationSettingsSchema,
    )
    settingsCtx.settings.register(
      settingsNamespace(RENDERING_SETTINGS_NAMESPACE),
      ConversationRenderingSettingsSchema,
      { base: config.rendering },
    )
  })
}

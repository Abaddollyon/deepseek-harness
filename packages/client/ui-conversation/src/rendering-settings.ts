/**
 * Deployment bounds on conversation render cost, carried through the settings
 * namespace because that is the channel a host-plane value reaches the browser
 * by (the client boot graph carries no per-entry config). Every field is
 * OPTIONAL: the built-in value lives in `dsh-client-ui-primitives`, which owns
 * the rendering code these bound, and an absent field leaves that value alone.
 * A deployment sets them from cordis.yml through this plugin's `Config`, which
 * publishes them as the namespace's base layer.
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace carrying the conversation render bounds. */
export const RENDERING_SETTINGS_NAMESPACE = 'ui-conversation-rendering'

/** Render bounds a deployment may tune; an omitted field keeps the built-in value. */
export interface ConversationRenderingSettings {
  /**
   * Longest source, in characters, the syntax highlighter will tokenize.
   * Tokenizing is one synchronous main-thread task linear in the source, so a
   * larger value trades interaction latency for highlighting on large fences
   * and read cards; above it a surface renders plain monospace.
   */
  highlightMaxChars?: number
  /** Highlighted results retained per output form (HTML and per-line runs each keep this many). */
  highlightCacheEntries?: number
  /** Settled Markdown messages whose rendered element trees are retained across mounts. */
  markdownCacheEntries?: number
}

/** Durable render-bounds schema; also the wire envelope the browser scope validates against. */
export const ConversationRenderingSettingsSchema: z<ConversationRenderingSettings> = z.object({
  highlightMaxChars: z.natural().min(1),
  highlightCacheEntries: z.natural(),
  markdownCacheEntries: z.natural(),
})

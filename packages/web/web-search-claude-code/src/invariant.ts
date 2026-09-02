/** Package invariant companion for the Claude Code native web-search provider.
 * @module @deepseek-ai/dsh-web-search-claude-code/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-claude-code'
/** Cordis companion plugin name. */
export const name = 'web-search-claude-code-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']
/** No runtime invariant: provider execution state is operation-local and enforced by the web seam. */
const install: InvariantInstaller = () => {}
/** Register this package's invariant companion.
 * @param ctx - context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

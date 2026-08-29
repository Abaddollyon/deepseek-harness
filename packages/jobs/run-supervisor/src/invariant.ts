/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-run-supervisor`.
 * @module @deepseek-ai/dsh-run-supervisor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-run-supervisor'

/** Cordis companion plugin name. */
export const name = 'run-supervisor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every fact the supervisor reconciles is a durable
 * record already zod-validated at the store boundary
 * (`@deepseek-ai/dsh-jobs-store-domain`), and every state transition it
 * drives goes through the registry's own first-wins settlement, whose
 * cross-field checks `@deepseek-ai/dsh-jobs/invariant` owns. The
 * supervisor's own decisions are policy (which record to settle, when), not
 * shape, so there is no package-local data invariant to install.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-jobs-store-domain`.
 * @module @deepseek-ai/dsh-jobs-store-domain/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-jobs-store-domain'

/** Cordis companion plugin name. */
export const name = 'jobs-store-domain-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every stored record is zod-validated at the durable
 * boundary (`jobRecordSchema` on load, whole-record replacement on write),
 * and `@deepseek-ai/dsh-jobs/invariant` owns the cross-field checks on the
 * registry snapshots projected from these records. Re-validating the same
 * schema after the domain layer already enforced it would verify the zod
 * library, not this package's decisions.
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

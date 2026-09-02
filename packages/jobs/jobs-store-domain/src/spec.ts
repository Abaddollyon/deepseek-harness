/**
 * The jobs domain declaration: the durable {@link JobRecord} schema and the
 * `defineDomain` spec the store opens over `ctx.storageDomain`. The zod
 * schemas are the durable-boundary validators; the spec object is the single
 * source of the domain's identity, version, and layout.
 * @module @deepseek-ai/dsh-jobs-store-domain/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'

/**
 * Version stamped into the backend unit for the jobs domain. Reject-only: a
 * medium stamped with a different version fails loud at open, never silently
 * discarding records — a discarded record would be a lie about work that may
 * still be running. Bump it monotonically with any layout change; there are
 * no compat shims pre-release.
 */
export const JOBS_DOMAIN_VERSION = 1

/** Job id schema at the durable boundary; branding has no runtime representation. */
const jobId = z.string().transform(value => value as JobId)

/**
 * Durable shape of one job record: the registry snapshot facts that must
 * survive a host restart (`reported` keeps notice gating correct, `resumeSpec`
 * decides boot adoption, `incarnation` names the owning process) plus a
 * record-level `schemaVersion` inside the domain version.
 */
export const jobRecordSchema = z.object({
  id: jobId,
  kind: z.string(),
  label: z.string(),
  ownerSession: z.string().transform(SessionId).nullable(),
  status: z.enum(['running', 'stopping', 'completed', 'killed', 'failed']),
  detail: z.string().nullable(),
  output: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
  reported: z.boolean(),
  outputLimitBytes: z.number().int().positive().nullable(),
  resumeSpec: z.json(),
  incarnation: z.string(),
  adoptedFromIncarnation: z.string().optional(),
  schemaVersion: z.literal(1),
})

/** One stored job record, inferred from {@link jobRecordSchema}. */
export type JobRecord = z.infer<typeof jobRecordSchema>

/**
 * Durable domain-global state: the incarnation of the process that last
 * opened the store and when it booted. Boot reconciliation consumers compare
 * record incarnations against the live process fact, not this snapshot; the
 * global exists as the durable account of the last boot.
 */
export const jobsDomainState = z.object({
  incarnation: z.string(),
  bootedAt: z.number().int().nonnegative(),
})

/** Durable domain-global state inferred from {@link jobsDomainState}. */
export type JobsDomainState = z.infer<typeof jobsDomainState>

/** Builder behind {@link createJobsDomainSpec}; exists so the exported face can name its type. */
function buildJobsDomainSpec(name: string) {
  return defineDomain({
    name,
    version: JOBS_DOMAIN_VERSION,
    global: {
      schema: jobsDomainState,
      initial: { incarnation: '', bootedAt: 0 },
    },
    tables: { records: domainTable<JobId, JobRecord>(jobRecordSchema) },
  })
}

/** The jobs domain spec type, shared by every configured domain name. */
export type JobsDomainSpec = ReturnType<typeof buildJobsDomainSpec>

/**
 * Build the jobs domain spec for one configured domain name. The name is
 * configurable (Config.domainName) so a deployment can route or namespace the
 * medium; identity, version, and layout are fixed here. An invalid name fails
 * loud inside `defineDomain` when the store opens.
 * @param name - domain (and backend unit) name; defaults to `'jobs'`.
 * @returns the domain spec the store opens through `ctx.storageDomain`.
 */
export function createJobsDomainSpec(name = 'jobs'): JobsDomainSpec {
  return buildJobsDomainSpec(name)
}

/** The default-named (`'jobs'`) domain spec. */
export const jobsDomainSpec: JobsDomainSpec = createJobsDomainSpec()

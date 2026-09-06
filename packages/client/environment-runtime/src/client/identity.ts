/** Stable identifier for one Host environment in the persistent client shell. */
export type EnvironmentId = string

/** Compound identity of one Session and the Host that owns it. */
export interface SessionRef {
  /** Owning Host environment. */
  readonly environmentId: EnvironmentId
  /** Host-local Session identifier. */
  readonly sessionId: string
}

/** Identity of one established generation of an environment runtime. */
export interface HostGeneration {
  /** Owning Host environment. */
  readonly environmentId: EnvironmentId
  /** Runtime incarnation that established the generation. */
  readonly runtimeId: string
  /** Monotonic generation within the runtime incarnation. */
  readonly generation: number
}

/**
 * Encode a Session reference without delimiter collisions.
 * @param ref - Host and Host-local Session identity.
 * @returns JSON tuple key suitable for scoped presentation state.
 */
export function sessionKey(ref: SessionRef): string {
  return JSON.stringify([ref.environmentId, ref.sessionId])
}

/** Shared environment scrubbing for managed subprocess consumers. */

import { DSH_ENV_PREFIX } from './types.ts'

/** Credential-shaped environment names excluded from implicit child inheritance. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Return the ambient parent environment without credential-shaped or DSH-owned names.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) {
      env[key] = value
    }
  }
  return env
}

/**
 * The process incarnation fact shared by the job registry and its durable
 * store. It lives in its own dependency-free leaf so a store provider can
 * stamp records without pulling the registry's `dsh-agent`-typed surface,
 * and so a browser-safe consumer can read it beside `./brand`.
 * @module @deepseek-ai/dsh-jobs/incarnation
 */

/**
 * Identity of the current host process, minted exactly once when this module
 * first loads. Durable job records carry the incarnation of the process that
 * owns them: a record whose incarnation differs from this value survived a
 * host restart and must be resumed or settled honestly, while a matching one
 * belongs to live in-process work. Minting at module load — not at service
 * construction — is what keeps an HMR reload of the registry from mistaking
 * live work for orphans: the module cache preserves the value across plugin
 * reloads, so only a real process restart changes it.
 */
export const PROCESS_INCARNATION: string = globalThis.crypto.randomUUID()

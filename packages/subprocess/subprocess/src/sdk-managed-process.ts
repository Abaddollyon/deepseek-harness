/** Managed subprocess projection for official SDK custom-spawn hooks. */

import { EventEmitter } from 'node:events'
import { scrubbedParentEnv } from './environment.ts'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from './types.ts'

/** Provider-neutral fields supplied by an official SDK custom-spawn hook. */
export interface SdkSpawnOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- the subprocess seam rejects with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Encode an SDK's complete child environment as a subprocess overlay.
 * @param env - SDK-composed child environment after its removals and replacements.
 * @returns explicit values plus tombstones for surviving ambient names the SDK removed.
 */
export function sdkEnvironmentOverlay(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

/**
 * Translate one official SDK spawn request to the shared process owner.
 * @param options - command, arguments, workspace, environment, and forwarded signal from the SDK.
 * @param graceMs - process-tree termination grace.
 * @returns the fully explicit shared subprocess request.
 */
export function sdkManagedSpawnSpec(
  options: SdkSpawnOptions,
  graceMs: number,
): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('SDK spawn request omitted its workspace')
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env),
  }
}

/** SDK-facing view of one shared managed process with piped stdin and stdout. */
export class ManagedSdkProcess {
  /** SDK-facing writable process input. */
  readonly stdin
  /** SDK-facing readable process output. */
  readonly stdout
  private readonly events = new EventEmitter()
  private outcomeValue: SubprocessOutcome | undefined
  private killRequested = false

  /**
   * Project a managed process with piped stdin and stdout.
   * @param child - shared handle that remains the process-tree authority.
   */
  constructor(private readonly child: SubprocessHandle) {
    this.stdin = child.stdin as NonNullable<SubprocessHandle['stdin']>
    this.stdout = child.stdout as NonNullable<SubprocessHandle['stdout']>
    // EventEmitter gives error special throw semantics without a listener. SDKs attach
    // their listener after custom spawn returns; this also contains an early rejection.
    this.events.on('error', () => {})
    void child.done.then(
      (outcome) => {
        this.outcomeValue = outcome
        this.events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        this.events.emit('error', thrown(error))
      },
    )
  }

  /** Whether the SDK has requested managed tree termination. */
  get killed(): boolean {
    return this.killRequested
  }

  /** Direct-child exit code, or null while running or after signal exit. */
  get exitCode(): number | null {
    return this.outcomeValue?.exitCode ?? null
  }

  /** Direct-child terminating signal, if any. */
  get signalCode(): NodeJS.Signals | null {
    return this.outcomeValue?.signal ?? null
  }

  /** Exact managed-process outcome after exit, or undefined while running. */
  get outcome(): SubprocessOutcome | undefined {
    return this.outcomeValue
  }

  /**
   * Route an SDK termination request to the tree-scoped process owner.
   * @param _signal - SDK-selected signal; the shared seam owns its escalation ladder.
   * @returns false only after exit or a previous termination request.
   */
  kill(_signal: NodeJS.Signals): boolean {
    if (this.killRequested || this.outcomeValue !== undefined) return false
    this.killRequested = true
    this.child.terminate()
    return true
  }

  /** Register a persistent process lifecycle listener.
   * @param event - process event name.
   * @param listener - event callback.
   */
  on(event: 'exit' | 'error', listener: ProcessListener): void {
    this.events.on(event, listener)
  }

  /** Register a one-shot process lifecycle listener.
   * @param event - process event name.
   * @param listener - event callback.
   */
  once(event: 'exit' | 'error', listener: ProcessListener): void {
    this.events.once(event, listener)
  }

  /** Remove a process lifecycle listener.
   * @param event - process event name.
   * @param listener - event callback.
   */
  off(event: 'exit' | 'error', listener: ProcessListener): void {
    this.events.off(event, listener)
  }
}

type ProcessListener = ((code: number | null, signal: NodeJS.Signals | null) => void)
  | ((error: Error) => void)

/**
 * Run consumer cleanup, terminate one managed process tree, and await full settlement.
 * @param child - optional managed subprocess handle.
 * @param prepare - optional protocol cleanup performed before termination.
 * @param failureMessage - aggregate teardown diagnostic.
 * @returns after the process tree and outcome promise have both settled.
 */
export async function disposeManagedSubprocess(
  child: SubprocessHandle | undefined,
  prepare: (() => void) | undefined,
  failureMessage: string,
): Promise<void> {
  const failures: unknown[] = []
  try {
    prepare?.()
  } catch (error: unknown) {
    failures.push(error)
  }
  if (child !== undefined) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await child.done
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, failureMessage)
}

/** Packaged ripgrep resolution and subprocess execution, independent of tool or Remote consumers; an execution world may name its own executable. */
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

let rgPathPromise: Promise<string> | undefined

/**
 * Resolve the packaged executable lazily, once per process. Single-file runtimes use an existing
 * `-rg` sidecar; Electron uses the unpacked ASAR path. Resolution failures reject
 * this call, not package loading. No system executable or remote fallback is used.
 * @returns the packaged executable's absolute path.
 */
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= Promise.resolve().then(async () => {
    const executable = parse(process.execPath)
    const executableSidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    if ('pkg' in process && existsSync(executableSidecar)) return executableSidecar
    const dependency = (await import('@vscode/ripgrep')).rgPath
    return process.versions.electron === undefined
      ? dependency
      : dependency.replace(/\.asar(?=[\\/])/u, '.asar.unpacked')
  })
  return rgPathPromise
}

/** Optional choices for one ripgrep start. */
export interface RipgrepSpawnOptions {
  /**
   * Ripgrep executable in the subprocess provider's execution world: an
   * absolute path or a name that world's PATH resolves. Omitted selects the
   * packaged Host binary from {@link resolveRgPath}, which a remote execution
   * world (for example one reached over SSH) cannot run. A blank value is
   * refused.
   */
  readonly executable?: string
}

/**
 * Start ripgrep with explicit subprocess settings. `spec.argv` contains only
 * rg arguments, without an executable. This function prepends the executable
 * (the configured override, else the resolved packaged binary) and
 * `--no-config`, so ambient configuration cannot enable a preprocessor. The
 * caller owns exit classification and process cleanup.
 * @param subprocess - the composed subprocess service.
 * @param spec - cwd, rg arguments (without the executable), stdio, signal and termination grace.
 * @param options - an optional executable override for a subprocess provider that runs elsewhere.
 * @returns the live subprocess handle; resolution and synchronous spawn failures reject.
 * @throws Error when `options.executable` is blank.
 */
export async function spawnRipgrep(
  subprocess: Pick<SubprocessRuntime, 'spawn'>,
  spec: SubprocessSpawnSpec,
  options: RipgrepSpawnOptions = {},
): Promise<SubprocessHandle> {
  if (options.executable !== undefined && options.executable.trim().length === 0) {
    throw new Error('ripgrep executable must be non-empty when given')
  }
  const executable = options.executable ?? await resolveRgPath()
  return subprocess.spawn({ ...spec, argv: [executable, '--no-config', ...spec.argv] })
}

/** Exit facts and whether the line consumer requested early termination. */
export interface RipgrepLinesResult {
  readonly outcome: SubprocessOutcome
  readonly stopped: boolean
}

/**
 * Read UTF-8 stdout records without retaining the complete output. A false
 * callback return terminates the process and suppresses remaining records.
 * Completion, callback failure and stream failure all await process quiescence;
 * provider failures reject. Exit codes and cancellation remain consumer-owned.
 * @param handle - an owned ripgrep process spawned with piped stdout.
 * Records are decoded as UTF-8, so bytes of a name that is not valid UTF-8
 * arrive replaced with U+FFFD.
 * @param separator - newline for text output, or NUL for file paths that may contain newlines.
 * @param onLine - synchronous record consumer; false requests early termination.
 * @returns exit facts after stdout and the managed process range settle.
 */
export async function readRipgrepLines(
  handle: SubprocessHandle,
  separator: '\n' | '\0',
  onLine: (line: string) => boolean,
): Promise<RipgrepLinesResult> {
  const stdout = handle.stdout
  if (stdout === undefined) {
    handle.terminate()
    await Promise.allSettled([handle.done, handle.waitForExit()])
    throw new Error('ripgrep requires piped stdout')
  }
  stdout.setEncoding('utf8')
  let stopped = false
  let completed = false
  const reading = (async () => {
    let pending = ''
    for await (const chunk of stdout as AsyncIterable<string>) {
      if (stopped) continue
      pending += chunk
      let end: number
      while ((end = pending.indexOf(separator)) !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!onLine(line)) {
          stopped = true
          pending = ''
          handle.terminate()
          break
        }
      }
    }
    if (pending.length > 0 && !onLine(pending)) {
      stopped = true
      handle.terminate()
    }
  })()
  try {
    const [, outcome] = await Promise.all([reading, handle.done])
    completed = true
    return { outcome, stopped }
  } finally {
    if (!completed) {
      handle.terminate()
      stdout.destroy()
    }
    await Promise.allSettled([reading, handle.done])
    await handle.waitForExit()
  }
}

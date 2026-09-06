/**
 * Run every lifecycle cleanup and report all failures after ownership is released.
 * @param steps - cleanup callbacks to run in order.
 */
export async function runCleanupSteps(
  steps: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'environment runtime: multiple cleanup failures')
}

/**
 * Preserve an operation failure while attaching any cleanup failure.
 * @param error - original operation failure.
 * @param steps - cleanup callbacks to run in order.
 * @returns the original failure or an aggregate containing cleanup failures.
 */
export async function failureAfterCleanup(
  error: unknown,
  steps: ReadonlyArray<() => void | Promise<void>>,
): Promise<unknown> {
  try {
    await runCleanupSteps(steps)
    return error
  } catch (cleanupError) {
    return new AggregateError([error, cleanupError], 'environment runtime: operation and cleanup failed')
  }
}

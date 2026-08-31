/**
 * Normalize an unknown JavaScript throw into the Error used by Codex failures.
 * @param value - the value thrown by a JavaScript operation.
 * @returns an Error preserving an existing Error or stringifying the value.
 */
export function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

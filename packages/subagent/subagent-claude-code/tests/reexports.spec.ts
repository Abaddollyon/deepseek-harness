import { describe, expect, it } from 'vitest'
import {
  claudeQueryOptions,
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
  sdkEnvironmentOverlay,
} from '../src/index.ts'
describe('public Claude SDK process exports', () => {
  it('exports the process helpers', () => {
    expect(typeof claudeSpawnSpec).toBe('function')
    expect(typeof ManagedClaudeCodeProcess).toBe('function')
    expect(typeof sdkEnvironmentOverlay).toBe('function')
    expect(typeof claudeQueryOptions).toBe('function')
  })
})

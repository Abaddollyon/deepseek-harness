import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
describe('loader composition', () => {
  it('declares the web and subprocess seams', () => {
    expect(name).toBe('web-search-claude-code')
    expect(inject).toEqual(['web', 'subprocess'])
  })
  it('registers and retains a disposer', () => {
    const disposer = vi.fn()
    const registerSearchProvider = vi.fn(() => disposer)
    const ctx = {
      web: { registerSearchProvider },
      effect: vi.fn((fn: () => Generator) => {
        fn().next()
      }),
    } as never
    apply(ctx, { cwd: '.' })
    expect(registerSearchProvider).toHaveBeenCalledOnce()
    expect(disposer).not.toHaveBeenCalled()
  })
  it('accepts every explicit configuration edge', () => {
    const dispose = vi.fn()
    const registerSearchProvider = vi.fn(() => dispose)
    const ctx = { web: { registerSearchProvider }, effect: vi.fn() } as never
    apply(ctx, {
      cwd: '/tmp',
      requestTimeoutMs: 1,
      disposeGraceMs: 1,
      maxResults: 1,
      maxTurns: 1,
      maxPayloadBytes: 1,
      executable: 'claude',
    })
    expect(registerSearchProvider).toHaveBeenCalledOnce()
  })
})

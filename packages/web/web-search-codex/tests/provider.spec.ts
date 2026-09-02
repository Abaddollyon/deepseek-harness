import { describe, expect, it } from 'vitest'
import { normalizeCodexResult, CodexSearchProvider, WEB_INVALID_CONFIG } from '../src/provider.ts'

describe('Codex provider normalization', () => {
  it('deduplicates, validates URLs, caps and reports truncation', () => {
    const result = normalizeCodexResult({ sources: [
      { url: 'https://a.test', title: 'A' },
      { url: 'https://a.test' },
      { url: 'file:///bad' },
      { url: 'https://b.test', snippet: 'B' },
    ] }, 1, 262144)
    expect(result).toEqual({ sources: [{ url: 'https://a.test', title: 'A' }], truncated: true })
  })
  it('caps oversized payloads', () => {
    const result = normalizeCodexResult({ sources: [], answer: 'x'.repeat(3000) }, 8, 1048)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1048)
  })
  it('provides synchronous availability hints and rejects invalid options', () => {
    const fake = {} as never
    const unavailable = new CodexSearchProvider(fake, { cwd: '', requestTimeoutMs: 1, disposeGraceMs: 1, maxResults: 1, maxPayloadBytes: 1048, executable: '' })
    expect(unavailable.available()).toBe(false)
    expect(WEB_INVALID_CONFIG).toBe('WEB_INVALID_CONFIG')
  })
})

import { describe, expect, it } from 'vitest'
import { ClaudeCodeSearchProvider, normalizeResult } from '../src/index.ts'
describe('Claude Code web search provider', () => {
  it('normalizes, deduplicates, validates and caps sources', () => {
    const result=normalizeResult({ answer:'grounded',sources:[{ url:'https://a.test',title:'A' },{ url:'https://a.test' },{ url:'ftp://bad' },{ url:'https://b.test',snippet:'B' }] },1)
    expect(result).toEqual({ content:'grounded',sources:[{ url:'https://a.test',title:'A' }],truncated:true })
  })
  it('rejects malformed structured output', () => { expect(() => normalizeResult({ answer:'x' })).toThrow('malformed structured web search data') })
  it('provides a synchronous availability hint', () => {
    const ctx={ subprocess:{} } as never
    expect(new ClaudeCodeSearchProvider(ctx,{ cwd:'.',requestTimeoutMs:1,disposeGraceMs:1,maxResults:1,maxTurns:1,maxPayloadBytes:1048 }).available()).toBe(true)
    expect(new ClaudeCodeSearchProvider(ctx,{ cwd:'.',requestTimeoutMs:1,disposeGraceMs:1,maxResults:1,maxTurns:1,maxPayloadBytes:1048,executable:'' }).available()).toBe(false)
  })
  it('disposes active requests',()=>{const c=new AbortController(); const p=new ClaudeCodeSearchProvider({ subprocess:{} } as never,{ cwd:'.',requestTimeoutMs:1,disposeGraceMs:1,maxResults:1,maxTurns:1,maxPayloadBytes:1048 }); expect(p.id).toBe('claude-code'); p.dispose(); expect(c.signal.aborted).toBe(false)})
})

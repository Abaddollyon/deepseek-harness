// @vitest-environment jsdom
// The render-cost contracts of the shared markdown surfaces: a lazy grammar
// landing re-highlights only the fences written in that language, highlighting
// is bounded and cached, and a settled message is parsed once per source.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { JsonTree } from '../src/JsonTree.tsx'
import { MarkdownText, configureMarkdownRendering, markdownRenderCacheSize } from '../src/markdown/MarkdownText.tsx'
import {
  DEFAULT_HIGHLIGHT_CONFIG, configureHighlighting, grammarLoadSource, highlightCacheSizes, highlightLines,
  highlightToHtml,
} from '../src/markdown/highlight.ts'
import * as highlight from '../src/markdown/highlight.ts'
import * as parse from '../src/markdown/parse.ts'

vi.mock('../src/markdown/highlight.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/markdown/highlight.ts')>()
  return { ...actual, highlightToHtml: vi.fn(actual.highlightToHtml) }
})

vi.mock('../src/markdown/parse.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/markdown/parse.ts')>()
  return { ...actual, parseGfmWithMath: vi.fn(actual.parseGfmWithMath) }
})

const highlightCalls = (lang: string): number =>
  vi.mocked(highlight.highlightToHtml).mock.calls.filter(call => call[1] === lang).length

describe('lazy grammar loads', () => {
  it('re-highlights only the fences written in the grammar that landed', async () => {
    // The storm this replaces: one global load counter invalidated the memo of
    // every mounted fence, so a python module arriving re-scanned every
    // TypeScript, shell, and JSON fence in the transcript.
    vi.mocked(highlight.highlightToHtml).mockClear()
    const view = render(
      <>
        <CodeBlock code="const x: number = 1" lang="ts" />
        <CodeBlock code="echo hi" lang="bash" />
        <div data-testid="rust-seat"><CodeBlock code="fn main() {}" lang="rust" /></div>
      </>,
    )
    const settledTypescript = highlightCalls('ts')
    const settledBash = highlightCalls('bash')

    await vi.waitFor(() => { expect(grammarLoadSource('rust').getSnapshot()).toBeGreaterThan(0) })
    await vi.waitFor(() => { expect(highlightCalls('rust')).toBeGreaterThan(1) })

    expect(highlightCalls('ts')).toBe(settledTypescript)
    expect(highlightCalls('bash')).toBe(settledBash)
    // The rust fence itself did pick the grammar up.
    expect(view.getByTestId('rust-seat').querySelector('.shiki')).not.toBeNull()
  })
})

describe('highlight bounds', () => {
  it('refuses to tokenize a source past the cap and leaves the plain fallback standing', () => {
    const oversized = 'const x = 1\n'.repeat(2_000)
    expect(oversized.length).toBeGreaterThan(DEFAULT_HIGHLIGHT_CONFIG.maxSourceChars)
    expect(highlightToHtml(oversized, 'ts')).toBeUndefined()
    const view = render(<CodeBlock code={oversized} lang="ts" />)
    expect(view.container.querySelector('.shiki')).toBeNull()
    expect(view.container.querySelector('pre')?.textContent).toContain('const x = 1')
  })

  it('raises and lowers the cap from configuration, dropping results on both edges', () => {
    const source = 'const x = 1\n'.repeat(2_000)
    const restore = configureHighlighting({ maxSourceChars: source.length })
    try {
      expect(highlightToHtml(source, 'ts')).toContain('shiki')
      expect(highlightCacheSizes().html).toBe(1)
    } finally {
      restore()
    }
    // The disposer restores the previous cap AND drops what the wider cap produced.
    expect(highlightCacheSizes().html).toBe(0)
    expect(highlightToHtml(source, 'ts')).toBeUndefined()
  })

  it('serves a repeated highlight from the cache instead of re-scanning the source', () => {
    const restore = configureHighlighting({ maxSourceChars: 200_000 })
    try {
      const source = 'export const value: number = 1\n'.repeat(400)
      const coldStart = performance.now()
      const cold = highlightToHtml(source, 'ts')
      const coldMs = performance.now() - coldStart
      const warmStart = performance.now()
      const warm = highlightToHtml(source, 'ts')
      const warmMs = performance.now() - warmStart
      expect(warm).toBe(cold)
      // The scan is linear in the source; a lookup is not. A tenth of the cold
      // cost is a wide margin around the measured three-orders-of-magnitude gap.
      expect(warmMs).toBeLessThan(coldMs / 10)
    } finally {
      restore()
    }
  })

  it('evicts least-recently-used results down to the configured bound', () => {
    const restore = configureHighlighting({ cacheEntries: 2 })
    try {
      highlightToHtml('const a = 1', 'ts')
      highlightToHtml('const b = 2', 'ts')
      expect(highlightCacheSizes().html).toBe(2)
      highlightToHtml('const c = 3', 'ts')
      expect(highlightCacheSizes().html).toBe(2)
      // 'a' was evicted; 'b' and 'c' are still hits, so the size holds.
      highlightToHtml('const b = 2', 'ts')
      expect(highlightCacheSizes().html).toBe(2)
    } finally {
      restore()
    }
  })

  it('applies the same cap and cache to the line runs the read card renders', () => {
    // ReadBlock tokenizes a whole read window in one call, so an unbounded file
    // read reached the same uncapped scan a large fence did.
    const oversized = 'const x = 1\n'.repeat(2_000)
    expect(highlightLines(oversized, 'ts')).toBeUndefined()
    const restore = configureHighlighting({ cacheEntries: 4 })
    try {
      const source = 'const a = 1\nconst b = 2'
      const first = highlightLines(source, 'ts')
      expect(first).not.toBeUndefined()
      // The identical array back is the cache hit: a re-tokenization would
      // build a new one.
      expect(highlightLines(source, 'ts')).toBe(first)
      expect(highlightCacheSizes().lines).toBe(1)
    } finally {
      restore()
    }
  })

  it('retains nothing when the bound is zero', () => {
    const restore = configureHighlighting({ cacheEntries: 0 })
    try {
      expect(highlightToHtml('const a = 1', 'ts')).toContain('shiki')
      expect(highlightCacheSizes().html).toBe(0)
    } finally {
      restore()
    }
  })
})

describe('settled markdown parsing', () => {
  it('parses a settled message once however often it mounts', () => {
    const restore = configureMarkdownRendering({ settledCacheEntries: 8 })
    try {
      vi.mocked(parse.parseGfmWithMath).mockClear()
      const text = '# Title\n\nA paragraph with **strong** text.\n'
      const first = render(<MarkdownText text={text} />)
      const parsedOnce = vi.mocked(parse.parseGfmWithMath).mock.calls.length
      expect(parsedOnce).toBe(1)
      const html = first.container.innerHTML
      first.unmount()
      // A remount is what scrolling a long transcript, switching view tabs, or
      // re-opening a session does to every settled message.
      const second = render(<MarkdownText text={text} />)
      expect(vi.mocked(parse.parseGfmWithMath).mock.calls.length).toBe(parsedOnce)
      expect(second.container.innerHTML).toBe(html)
    } finally {
      restore()
    }
  })

  it('separates renders that baked in different owner objects', () => {
    const restore = configureMarkdownRendering({ settledCacheEntries: 8 })
    try {
      vi.mocked(parse.parseGfmWithMath).mockClear()
      const text = 'plain body\n'
      render(<MarkdownText text={text} codeLabels={{ copyLabel: 'A', copiedLabel: 'A!' }} />)
      render(<MarkdownText text={text} codeLabels={{ copyLabel: 'B', copiedLabel: 'B!' }} />)
      // Cached elements captured their owner's callbacks, so a different owner
      // must not be served a tree built for the previous one.
      expect(vi.mocked(parse.parseGfmWithMath).mock.calls.length).toBe(2)
    } finally {
      restore()
    }
  })

  it('bounds the cache and drops it when the bound changes', () => {
    const restore = configureMarkdownRendering({ settledCacheEntries: 2 })
    try {
      render(<MarkdownText text="one" />)
      render(<MarkdownText text="two" />)
      render(<MarkdownText text="three" />)
      expect(markdownRenderCacheSize()).toBe(2)
    } finally {
      restore()
    }
    expect(markdownRenderCacheSize()).toBe(0)
  })

  it('keeps streaming renders out of the settled cache', () => {
    const restore = configureMarkdownRendering({ settledCacheEntries: 8 })
    try {
      render(<MarkdownText text="streaming body" streaming />)
      expect(markdownRenderCacheSize()).toBe(0)
    } finally {
      restore()
    }
  })
})

describe('JsonTree hover', () => {
  it('leaves sibling rows untouched when the pointer crosses a row', () => {
    // Re-rendering a row re-runs entriesOf and the recursive preview, both of
    // which read the underlying value; a counting proxy therefore observes
    // exactly the work a row costs.
    let reads = 0
    const counted = new Proxy({ alpha: 1, beta: 2 }, {
      get: (target, key, receiver): unknown => {
        reads += 1
        return Reflect.get(target, key, receiver)
      },
      ownKeys: (target) => {
        reads += 1
        return Reflect.ownKeys(target)
      },
    })
    const view = render(<JsonTree data={{ first: counted, second: { gamma: 3 } }} />)
    const rows = within(screen.getByRole('tree')).getAllByRole('treeitem')
    const afterMount = reads
    expect(afterMount).toBeGreaterThan(0)

    fireEvent.mouseOver(rows[1] as HTMLElement)
    expect(screen.getByRole('button', { name: /Copy/ })).toBeDefined()
    expect(reads).toBe(afterMount)

    fireEvent.mouseOver(rows[0] as HTMLElement)
    expect(reads).toBe(afterMount)
    view.unmount()
  })
})

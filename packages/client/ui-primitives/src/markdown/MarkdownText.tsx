/**
 * Untrusted assistant-Markdown renderer over the direct mdast pipeline:
 * `parse.ts` grammars, the incremental streaming parser, and `render.tsx`.
 * While a message streams, all but the trailing two blocks freeze as cached
 * React elements and only the source tail behind them re-parses per chunk,
 * so per-chunk work tracks the tail size instead of the whole reply. Frozen
 * blocks keep their source-offset keys when they cross the freeze boundary,
 * so React reconciles instead of remounting. A SETTLED message's element tree
 * is retained in a bounded module-level cache keyed on its source and the two
 * owner objects baked into it, so remounting one costs a lookup rather than a
 * full re-parse. Known deviation while
 * streaming: a reference-style link or footnote whose definition sits on the
 * other side of the freeze boundary renders literally until the settled
 * full parse self-heals it.
 */

import { memo, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { BoundedCache, IdentityKeys } from '../bounded-cache.ts'
import { IncrementalMarkdownParser } from './incremental.ts'
import { parseGfm, parseGfmWithMath } from './parse.ts'
import {
  collectReferenceTargets, createReferenceTargets, renderBlocks, renderFootnoteSection,
  wrapBlockChildren,
} from './render.tsx'
import type { MarkdownCodeLabels, MarkdownFileMentions, MarkdownRenderContext, ReferenceTargets } from './render.tsx'
import 'katex/dist/katex.min.css'
import css from './MarkdownText.module.css'

export type { MarkdownCodeLabels, MarkdownFileMentions } from './render.tsx'

/**
 * Deployment-tunable bound on the settled-render cache. A settled message's
 * element tree is a pure function of its source and the two owner objects
 * baked into it, so remounting one — a view-tab switch, a session switch, a
 * windowed list scrolling a row back in — need not re-parse it. The owning
 * plugin publishes the bound through {@link configureMarkdownRendering}; this
 * package is cordis-free and never reads configuration itself.
 */
export interface MarkdownRenderConfig {
  /**
   * Settled messages whose rendered element trees are retained. Measured cost
   * avoided per hit is ≈1.3 ms per Markdown block (parse plus element build).
   * Zero disables caching.
   */
  settledCacheEntries: number
}

/** Built-in bound: a long transcript's visible window plus scroll-back headroom. */
export const DEFAULT_MARKDOWN_RENDER_CONFIG: MarkdownRenderConfig = {
  settledCacheEntries: 256,
}

let activeConfig: MarkdownRenderConfig = { ...DEFAULT_MARKDOWN_RENDER_CONFIG }

/**
 * Keyed on `(text, codeLabels identity, fileMentions identity)`: the produced
 * elements captured those two objects' callbacks, so a cache hit must have
 * been produced under the same ones. Both identities are per-locale-revision
 * and per-session respectively, so a session that goes away simply stops
 * producing hits and its entries evict; the bound makes that unconditional.
 */
const settledCache = new BoundedCache<ReactNode[]>(() => activeConfig.settledCacheEntries)
const ownerKeys = new IdentityKeys()

/**
 * Apply the deployment bound to the settled-render cache. The cache is dropped
 * on both edges so no element tree outlives the bound it was retained under.
 * @param next - fields to override; omitted fields keep their current value.
 * @returns a disposer restoring the previous bound.
 */
export function configureMarkdownRendering(next: Partial<MarkdownRenderConfig>): () => void {
  const previous = activeConfig
  activeConfig = { ...activeConfig, ...next }
  settledCache.clear()
  return () => {
    activeConfig = previous
    settledCache.clear()
  }
}

/**
 * Retained settled-render count, for tests asserting the cache is bounded and used.
 * @returns the number of settled renders currently retained.
 */
export function markdownRenderCacheSize(): number {
  return settledCache.size
}

/** One settled full render: parse with math, resolve references, append the footnote section. */
function renderSettled(
  text: string,
  codeLabels: MarkdownCodeLabels | undefined,
  fileMentions: MarkdownFileMentions | undefined,
): ReactNode[] {
  const root = parseGfmWithMath(text)
  const targets = createReferenceTargets()
  collectReferenceTargets(root.children, targets)
  const context: MarkdownRenderContext = {
    streaming: false,
    codeLabels,
    fileMentions,
    targets,
    footnoteOrder: [],
    footnoteCounts: new Map(),
  }
  const blocks = wrapBlockChildren(
    renderBlocks(root.children.map((node, index) => ({ node, key: index })), context),
    false,
  )
  const section = renderFootnoteSection(context)
  return section === null ? blocks : [...blocks, '\n', section]
}

/**
 * The settled render for `text` under these owners, parsed at most once per
 * `(text, owners)` while it stays within the cache bound.
 * @param text - the settled Markdown source.
 * @param codeLabels - fence copy labels baked into the produced elements.
 * @param fileMentions - the file-mention resolver baked into the produced elements.
 * @returns the rendered block children.
 */
function settledChildren(
  text: string,
  codeLabels: MarkdownCodeLabels | undefined,
  fileMentions: MarkdownFileMentions | undefined,
): ReactNode[] {
  const key = `${ownerKeys.keyFor(codeLabels)}:${ownerKeys.keyFor(fileMentions)}:${text}`
  const cached = settledCache.get(key)
  if (cached !== undefined) return cached
  const children = renderSettled(text, codeLabels, fileMentions)
  settledCache.set(key, children)
  return children
}

/**
 * Streaming render state for one growing message: the incremental parser,
 * the frozen blocks' cached elements, and the reference/footnote state their
 * rendering consumed (footnote numbering assigned to frozen references is
 * final, so the tail continues from a copy of it each frame).
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm)
  private generation = -1
  private frozenCount = 0
  private frozenElements: ReactNode[] = []
  private frozenTargets: ReferenceTargets = createReferenceTargets()
  private frozenFootnoteOrder: string[] = []
  private frozenFootnoteCounts = new Map<string, number>()
  private lastText: string | null = null
  private lastRendered: ReactNode[] = []

  /** @param codeLabels - Fence copy labels baked into cached elements; the owner replaces the renderer when they change. */
  constructor(private readonly codeLabels: MarkdownCodeLabels | undefined) {}

  /**
   * Render the current accumulated text. Idempotent per text value, so React
   * may re-execute the calling render freely.
   * @param text - The full accumulated markdown source.
   * @returns Frozen elements, re-rendered tail, and the footnote section.
   */
  render(text: string): ReactNode[] {
    if (text === this.lastText) return this.lastRendered
    const { frozen, tail, generation } = this.parser.update(text)
    if (generation !== this.generation) {
      this.generation = generation
      this.frozenCount = 0
      this.frozenElements = []
      this.frozenTargets = createReferenceTargets()
      this.frozenFootnoteOrder = []
      this.frozenFootnoteCounts = new Map()
    }
    const newlyFrozen = frozen.slice(this.frozenCount)
    collectReferenceTargets(newlyFrozen.map(block => block.node), this.frozenTargets)
    // Targets visible this frame: everything frozen so far plus the current
    // tail parse — a newly frozen block's references resolved against the
    // same parse tree its definitions came from.
    const frameTargets: ReferenceTargets = {
      definitions: new Map(this.frozenTargets.definitions),
      footnotes: new Map(this.frozenTargets.footnotes),
    }
    collectReferenceTargets(tail.map(block => block.node), frameTargets)
    if (newlyFrozen.length > 0) {
      const frozenContext: MarkdownRenderContext = {
        streaming: true,
        codeLabels: this.codeLabels,
        fileMentions: undefined,
        targets: frameTargets,
        footnoteOrder: this.frozenFootnoteOrder,
        footnoteCounts: this.frozenFootnoteCounts,
      }
      // Separator newlines are cached alongside the elements so the
      // assembled children match the settled pipeline's block wrapping.
      const batch = [...this.frozenElements]
      for (const element of renderBlocks(newlyFrozen, frozenContext)) {
        if (batch.length > 0) batch.push('\n')
        batch.push(element)
      }
      this.frozenElements = batch
      this.frozenCount = frozen.length
    }
    const tailContext: MarkdownRenderContext = {
      streaming: true,
      codeLabels: this.codeLabels,
      fileMentions: undefined,
      targets: frameTargets,
      footnoteOrder: [...this.frozenFootnoteOrder],
      footnoteCounts: new Map(this.frozenFootnoteCounts),
    }
    const children = [...this.frozenElements]
    for (const element of renderBlocks(tail, tailContext)) {
      if (children.length > 0) children.push('\n')
      children.push(element)
    }
    const section = renderFootnoteSection(tailContext)
    if (section !== null) children.push('\n', section)
    this.lastText = text
    this.lastRendered = children
    return this.lastRendered
  }
}

/**
 * Render untrusted assistant-authored Markdown as semantic React elements.
 * @param props - Markdown source text preserved by the session projection;
 * `streaming` renders fences and TeX plain (highlighting and KaTeX land on
 * the finalize swap) and parses incrementally across chunks; `codeLabels`
 * forwards localized copy-button labels to fence CodeBlocks — pass a
 * reference-stable object (memoized per locale revision), because a new
 * identity discards the streaming render cache mid-message. `fileMentions`
 * links inline-code tokens its resolver recognizes as real files; this is
 * the single streaming gate — it applies to settled renders only, because a
 * streaming message's vocabulary is not final and frozen cached elements
 * must not bake in handlers that could go stale. A settled render is served
 * from the bounded module cache when the same source and the same two owner
 * objects were rendered before.
 * @returns A GFM document with TeX math rendered through KaTeX; raw HTML,
 * relative links, and unsafe protocols are disabled, while absolute HTTP(S)
 * images render directly.
 */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false, codeLabels, fileMentions }: {
  text: string
  streaming?: boolean
  codeLabels?: MarkdownCodeLabels | undefined
  fileMentions?: MarkdownFileMentions | undefined
}) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const streamLabelsRef = useRef<MarkdownCodeLabels | undefined>(codeLabels)
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return settledChildren(text, codeLabels, fileMentions)
    }
    if (streamRef.current === null || streamLabelsRef.current !== codeLabels) {
      streamRef.current = new StreamingRenderer(codeLabels)
      streamLabelsRef.current = codeLabels
    }
    return streamRef.current.render(text)
  }, [text, streaming, codeLabels, fileMentions])
  return <div className={css.markdown}>{children}</div>
})

/**
 * Incremental block-level markdown parsing for an append-only text stream.
 *
 * Re-parsing the whole accumulated document on every streaming chunk is
 * quadratic in the final reply length. CommonMark block parsing is line-based
 * and appended text can only reshape the parse frontier — the last top-level
 * block (a paragraph becoming a setext heading or a table, a list continuing
 * after a blank line, an unclosed fence swallowing lines) — so earlier blocks
 * are final. This parser therefore freezes all but the trailing
 * {@link UNSTABLE_TAIL_BLOCKS} blocks and re-parses only the source tail
 * behind them. An oversized tail is parsed at byte checkpoints while its
 * newest suffix renders as plain text, rather than being parsed per chunk.
 *
 * The freeze boundary comes from the parser's own `position` offsets, never
 * from custom source scanning. The cut sits at the *end offset* of the last
 * frozen block (not the next block's start): a following block's start offset
 * excludes up to three spaces of insignificant leading indentation, which is
 * harmless to drop, but cutting at the previous end also keeps the
 * inter-block blank lines in the tail so the sliced source stays verbatim.
 *
 * Known deviation, shared with any prefix-freeze scheme: micromark resolves
 * reference-style links and footnotes document-wide at parse time, so a
 * reference whose definition lands on the other side of the freeze boundary
 * renders literally until the settled full parse self-heals it.
 */

import type { Root, RootContent } from 'mdast'

/**
 * Trailing blocks kept unstable. Appended text reshapes at most the last
 * block; the second-to-last is retained as safety margin so a freeze decision
 * never has to reason about the parse frontier.
 */
const UNSTABLE_TAIL_BLOCKS = 2

/** New UTF-8 bytes accepted before an oversized unstable tail is parsed again. */
const LIVE_PARSE_CHECKPOINT_BYTES = 8 * 1024

/** Constant-size windows used to recognize the prior source without rescanning it. */
const PREFIX_SAMPLE_SIZE = 32

/** UTF-8 encoder shared by append accounting. */
const utf8 = new TextEncoder()

/** A top-level mdast block plus a render key that is stable across chunks. */
export interface PositionedBlock {
  /** The parsed block. Positions inside it are relative to its parse slice. */
  readonly node: RootContent
  /**
   * The block's start offset in the full source text. Stable from the frame
   * a block first appears through freezing, so React reconciles rather than
   * remounts when a block crosses the freeze boundary.
   */
  readonly key: number
}

/** One {@link IncrementalMarkdownParser.update} result. */
export interface IncrementalBlocks {
  /** Blocks that can no longer change; grows monotonically per generation. */
  readonly frozen: readonly PositionedBlock[]
  /** Parsed unstable blocks plus any plain-text growth since an oversized-tail checkpoint. */
  readonly tail: readonly PositionedBlock[]
  /** Bumped whenever non-append input discards the frozen prefix; callers drop caches keyed on it. */
  readonly generation: number
}

/**
 * A block's render key: its absolute source start offset. A position-less
 * node (a grammar is free to omit positions) falls back to a negative
 * list-index key — unique within one update's tail, which is the only place
 * the fallback can occur: freezing requires the cut block's position, so a
 * position-less parse keeps every block in the tail (real grammars always
 * stamp positions and never take this path).
 */
function blockKey(node: RootContent, base: number, index: number): number {
  const offset = node.position?.start.offset
  return offset === undefined ? -(index + 1) : base + offset
}

/** Plain rendering used only for bytes after the latest live parse checkpoint. */
function plainTextBlock(value: string): PositionedBlock {
  return {
    node: { type: 'paragraph', children: [{ type: 'text', value }] },
    key: -1,
  }
}

/**
 * Append-only incremental parser over a caller-supplied grammar. One instance
 * accumulates one streaming document; non-append input resets it.
 */
export class IncrementalMarkdownParser {
  private prevText = ''
  private tailStart = 0
  private frozen: PositionedBlock[] = []
  private generation = 0
  private cached: IncrementalBlocks | null = null
  private checkpointLength = 0
  private checkpointTail: PositionedBlock[] = []
  private appendedBytesSinceCheckpoint = 0

  /** @param parse - Grammar shared with whatever renders the blocks, so boundaries agree. */
  constructor(private readonly parse: (text: string) => Root) {}

  /**
   * Fold the current accumulated text and return the frozen/tail split.
   * Idempotent for identical input (the previous result is returned as-is),
   * so callers may invoke it from render paths that re-execute.
   * @param text - The full accumulated markdown source.
   * @returns Frozen and tail blocks with stream-stable render keys.
   */
  update(text: string): IncrementalBlocks {
    return this.fold(text, false)
  }

  /**
   * Finish a stream with a real parse regardless of the next checkpoint.
   * @param text - Complete markdown source.
   * @returns Fully parsed blocks for the settled source.
   */
  settle(text: string): IncrementalBlocks {
    return this.fold(text, true)
  }

  /** Parse a checkpoint or cheaply extend its displayed plain-text suffix. */
  private fold(text: string, settled: boolean): IncrementalBlocks {
    if (!settled && this.cached !== null && text === this.prevText) return this.cached
    const appendOnly = this.hasPriorPrefix(text)
    if (!appendOnly) this.reset()

    const appended = text.slice(this.prevText.length)
    this.prevText = text
    this.appendedBytesSinceCheckpoint += utf8.encode(appended).byteLength
    const checkpointTailLength = this.checkpointLength - this.tailStart
    if (!settled && this.cached !== null
      && checkpointTailLength >= LIVE_PARSE_CHECKPOINT_BYTES
      && this.appendedBytesSinceCheckpoint < LIVE_PARSE_CHECKPOINT_BYTES) {
      const suffix = text.slice(this.checkpointLength)
      const tail = suffix.length === 0
        ? this.checkpointTail
        : [...this.checkpointTail, plainTextBlock(suffix)]
      this.cached = { frozen: [...this.frozen], tail, generation: this.generation }
      return this.cached
    }

    const base = this.tailStart
    const blocks = this.parse(text.slice(base)).children
    let firstUnstable = Math.max(0, blocks.length - UNSTABLE_TAIL_BLOCKS)
    if (firstUnstable > 0) {
      const cutEnd = blocks[firstUnstable - 1]?.position?.end.offset
      if (cutEnd === undefined) {
        // A grammar that omits positions leaves nothing to cut at; keep the
        // whole parse in the tail rather than guessing a boundary.
        firstUnstable = 0
      } else {
        for (const node of blocks.slice(0, firstUnstable)) {
          this.frozen.push({ node, key: blockKey(node, base, this.frozen.length) })
        }
        this.tailStart = base + cutEnd
      }
    }
    this.checkpointTail = blocks.slice(firstUnstable).map((node, index) => ({
      node,
      key: blockKey(node, base, index),
    }))
    this.checkpointLength = text.length
    this.appendedBytesSinceCheckpoint = 0
    this.cached = { frozen: [...this.frozen], tail: this.checkpointTail, generation: this.generation }
    return this.cached
  }

  /** Recognize ordinary appends from constant-size samples of the retained prefix. */
  private hasPriorPrefix(text: string): boolean {
    const length = this.prevText.length
    if (length === 0) return true
    if (text.length < length) return false
    const starts = new Set([0, Math.max(0, Math.floor(length / 2) - Math.floor(PREFIX_SAMPLE_SIZE / 2)),
      Math.max(0, length - PREFIX_SAMPLE_SIZE)])
    for (const start of starts) {
      const end = Math.min(length, start + PREFIX_SAMPLE_SIZE)
      if (text.slice(start, end) !== this.prevText.slice(start, end)) {
        // A sample mismatch is unusual for an append. Verify the complete
        // prefix before treating it as a rewrite so the fast path cannot
        // falsely reset a valid stream.
        return text.startsWith(this.prevText)
      }
    }
    return true
  }

  /** Drop every append-generation cache after a verified rewrite. */
  private reset(): void {
    this.prevText = ''
    this.tailStart = 0
    this.frozen = []
    this.checkpointLength = 0
    this.checkpointTail = []
    this.appendedBytesSinceCheckpoint = 0
    this.cached = null
    this.generation += 1
  }
}

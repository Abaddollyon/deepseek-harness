/**
 * The client's ONE syntax highlighter: a synchronous fine-grained shiki core
 * (JavaScript regex engine — no oniguruma WASM, bundle-friendly) with an
 * explicit grammar allowlist and a CSS-variables theme. Colors live in the
 * theme package's token sheets as `--shiki-*` custom properties (light and
 * dark blocks), never here — the repo's tokens-only styling rule.
 *
 * Only the three markdown-fence and `run_code` grammars (TypeScript, shell,
 * JSON) load into the singleton at boot — the set every session renders. The
 * read card's wider extension set (the file-extension language hints the read
 * tool's `langFromPath` emits — `packages/fs/tool-fs`: python, rust, yaml,
 * markup, …) is imported lazily and registered the first time such a language
 * is requested, so a session that never opens a read card in one of those
 * languages pays neither the ~1.6 MB of grammar modules nor their synchronous
 * init. The first render of a lazy language falls back to plain text while its
 * grammar loads, then that grammar's own {@link grammarLoadSource} notifies its
 * subscribers to re-render with highlighting — a load never disturbs surfaces
 * written in another language. An unknown or absent language falls back to plain
 * text (no highlighting, still monospace) — never an error.
 *
 * Tokenizing is a synchronous main-thread task linear in the source length, so
 * {@link HighlightConfig} bounds both the largest source this module will scan
 * and the number of results it retains; the owning plugin publishes those
 * bounds through {@link configureHighlighting}.
 */

import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import type { HighlighterCore } from 'shiki/core'
import type { CSSProperties } from 'react'
import { BoundedCache } from '../bounded-cache.ts'

/** A shiki grammar module's default export (a `LanguageRegistration[]`), taken
 *  from a boot grammar so no direct `@shikijs/types` dependency is needed. */
type LangModule = { default: typeof langTs }

/**
 * Grammars the singleton loads at boot; each entry's own `name` is the id
 * `codeToTokens`/`codeToHtml` resolve. The JS-family aliases (js/jsx/ts/tsx)
 * resolve to the TypeScript grammar rather than a separate one: it tokenizes
 * plain TS/JS exactly, and JSX/TSX approximately (shiki's TS grammar is not the
 * dedicated TSX grammar, so JSX elements tokenize imperfectly) — an accepted
 * trade to keep the boot set to one JS-family grammar. The read card's wider
 * set loads lazily through {@link LAZY_GRAMMARS}.
 */
const LANGS = [langTs, langBash, langJson]

/**
 * The read card's extension grammars, each behind a dynamic import so its
 * module stays out of the boot chunk until a read of that language renders.
 * Keyed by the grammar id (`LanguageRegistration.name`) the aliases resolve to.
 * `@shikijs/langs`' default export is a `LanguageRegistration[]`; the loader
 * hands the whole array to `loadLanguageSync`, which registers each entry
 * (including embedded sub-grammars). The three boot grammars are absent —
 * already loaded, so no alias value ever points at a missing entry here.
 */
const LAZY_GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['mdx', () => import('@shikijs/langs/mdx')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
])

/**
 * Language ids (and aliases) the highlighter accepts; everything else renders
 * plain. A Map, not an object: fence info strings are assistant-authored, so
 * a label like `constructor` or `__proto__` must miss instead of resolving an
 * inherited property and crashing the renderer inside shiki. Keys cover both
 * the markdown-fence aliases `CodeBlock` uses and the file-extension hint ids
 * the read tool's `langFromPath` emits, so both callers resolve the same
 * grammars. The JS family maps to the TypeScript grammar (see {@link LANGS} for
 * the JSX/TSX approximation). A value not in {@link LANGS} names a
 * {@link LAZY_GRAMMARS} entry loaded on first use.
 */
const LANG_ALIASES = new Map<string, string>([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['php', 'php'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
])

/** All token colors resolve through `--shiki-*` custom properties (theme package sheets). */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

/**
 * The client regex engine compiles each TextMate pattern when its scanner is
 * created. Shiki otherwise defers patterns longer than 3,000 characters until
 * their first match; that compilation counts against Shiki's 500 ms per-line
 * budget and can return a partial token stream under host contention. Eager
 * compilation leaves the same budget in place for scanning user content.
 */
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

let singleton: HighlighterCore | undefined

/** Representative paths through every boot grammar, compiled before user content is timed. */
const BOOT_GRAMMAR_WARMUPS = [
  { lang: 'typescript', code: 'const answer: number = 42' },
  { lang: 'shellscript', code: 'printf \'%s\\n\' "$HOME"' },
  { lang: 'json', code: '{"ready":true}' },
] as const

/** Construct and pre-tokenize the boot grammars outside the user-content scan budget. */
function createHighlighter(): HighlighterCore {
  const instance = createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  })
  for (const sample of BOOT_GRAMMAR_WARMUPS) {
    instance.codeToTokens(sample.code, {
      lang: sample.lang,
      theme: 'css-variables',
      tokenizeTimeLimit: 0,
    })
  }
  return instance
}

/** The synchronous highlighter (one instance per document); pre-warmed below, lazy as the fallback. */
function highlighter(): HighlighterCore {
  singleton ??= createHighlighter()
  return singleton
}

/**
 * Deployment-tunable bounds on the shared highlighter. Both are costs the
 * DEPLOYMENT trades, not protocol constants: the cap trades highlighting on
 * very large surfaces against main-thread latency, and the cache size trades
 * retained memory against re-tokenization. The owning plugin publishes them
 * through {@link configureHighlighting}; this package is cordis-free and never
 * reads configuration itself.
 */
export interface HighlightConfig {
  /**
   * Longest source, in characters, this highlighter will tokenize. Tokenizing
   * is one synchronous main-thread task whose cost is linear in the source
   * (measured ≈10 ms per 1,000 characters of TSX on a desktop), so an
   * unbounded call freezes the tab. Above the cap {@link highlightToHtml} and
   * {@link highlightLines} report "no highlighting" and the caller draws its
   * plain fallback.
   */
  maxSourceChars: number
  /**
   * Highlighted results retained per output form (HTML and line runs keep one
   * cache each). A cached result makes a re-render a map lookup instead of a
   * re-scan; retained bytes are bounded by this count times
   * {@link HighlightConfig.maxSourceChars}. Zero disables caching.
   */
  cacheEntries: number
}

/**
 * Built-in bounds. `maxSourceChars` holds one tokenization near 100 ms on the
 * measured desktop; `cacheEntries` covers a long transcript's live fence set
 * without retaining a session's worth of source.
 */
export const DEFAULT_HIGHLIGHT_CONFIG: HighlightConfig = {
  maxSourceChars: 10_000,
  cacheEntries: 128,
}

let activeConfig: HighlightConfig = { ...DEFAULT_HIGHLIGHT_CONFIG }

const cacheLimit = (): number => activeConfig.cacheEntries
const htmlCache = new BoundedCache<string>(cacheLimit)
const lineCache = new BoundedCache<HighlightSpan[][]>(cacheLimit)

/**
 * Apply deployment bounds to the shared highlighter. Caches are dropped on
 * both edges so no result outlives the bounds it was produced under. Calls
 * nest by restore order (the disposer reinstates the values that were active
 * when it was taken), matching the plugin-effect teardown it is registered as.
 * @param next - fields to override; omitted fields keep their current value.
 * @returns a disposer restoring the previous bounds.
 */
export function configureHighlighting(next: Partial<HighlightConfig>): () => void {
  const previous = activeConfig
  activeConfig = { ...activeConfig, ...next }
  htmlCache.clear()
  lineCache.clear()
  return () => {
    activeConfig = previous
    htmlCache.clear()
    lineCache.clear()
  }
}

/**
 * Retained-result counts, for tests asserting the cache is bounded and used.
 * @returns the entry count of each output form's cache.
 */
export function highlightCacheSizes(): { html: number; lines: number } {
  return { html: htmlCache.size, lines: lineCache.size }
}

/** @param lang - a fence info string or caller id. @returns the grammar id it names, or undefined. */
function resolveGrammar(lang: string | undefined): string | undefined {
  return lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
}

/** Cache key: the grammar id cannot contain a newline, so the join is unambiguous. */
function cacheKey(resolved: string, code: string): string {
  return `${resolved}\n${code}`
}

/** Grammar ids whose lazy import is in flight or done, so it is requested once. */
const requested = new Set<string>()

/**
 * A `useSyncExternalStore` source for ONE grammar's load state. Both members
 * are identity-stable for the lifetime of the document, so a component may
 * call {@link grammarLoadSource} on every render without churning its
 * subscription.
 */
export interface GrammarLoadSource {
  /** `useSyncExternalStore` subscribe: fires only when THIS grammar registers. */
  subscribe: (listener: () => void) => () => void
  /** `useSyncExternalStore` snapshot: opaque counter, changes only on this grammar's load. */
  getSnapshot: () => number
}

interface GrammarLoadState {
  listeners: Set<() => void>
  count: number
  source: GrammarLoadSource
}

/** Per-grammar load state, created on first request for that grammar id. */
const grammarLoads = new Map<string, GrammarLoadState>()

/**
 * The source handed to callers whose language resolves to no grammar at all.
 * Such a caller can never gain highlighting, so its snapshot is a constant and
 * a subscription would only cost a set entry per mounted plain fence.
 */
const INERT_LOAD_SOURCE: GrammarLoadSource = {
  subscribe: () => () => {},
  getSnapshot: () => 0,
}

function grammarLoadState(resolved: string): GrammarLoadState {
  let state = grammarLoads.get(resolved)
  if (state === undefined) {
    const listeners = new Set<() => void>()
    state = {
      listeners,
      count: 0,
      source: {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /* v8 ignore next -- the closure reads the live record it was created for. */
        getSnapshot: () => grammarLoads.get(resolved)?.count ?? 0,
      },
    }
    grammarLoads.set(resolved, state)
  }
  return state
}

/**
 * The lazy-grammar load source for `lang`, scoped to the ONE grammar that
 * language resolves to. A grammar landing therefore re-renders only the
 * surfaces that asked for it: a `python` module arriving leaves every mounted
 * TypeScript, shell, and JSON surface untouched instead of re-tokenizing them.
 * The returned object is cached per resolved grammar id, so calling this on
 * every render is free and never resubscribes.
 * @param lang - the language hint (a markdown fence info string or a fixed caller id).
 * @returns a stable subscribe/snapshot pair for that grammar, or an inert pair for an unknown language.
 */
export function grammarLoadSource(lang: string | undefined): GrammarLoadSource {
  const resolved = resolveGrammar(lang)
  if (resolved === undefined) return INERT_LOAD_SOURCE
  return grammarLoadState(resolved).source
}

/**
 * Ensure the grammar `resolved` names is registered. A boot grammar (not in
 * {@link LAZY_GRAMMARS}) and an already-loaded lazy grammar report ready
 * synchronously; a lazy grammar not yet loaded starts its import (once) and
 * reports not-ready, so the caller renders plain until that grammar's own
 * {@link grammarLoadSource} listeners fire.
 * @param resolved - the grammar id an alias resolved to.
 * @returns whether the grammar is registered and ready to tokenize now.
 */
function ensureGrammar(resolved: string): boolean {
  const load = LAZY_GRAMMARS.get(resolved)
  // A boot grammar (already registered) has no lazy loader; it is always ready.
  if (load === undefined) return true
  if (highlighter().getLoadedLanguages().includes(resolved)) return true
  if (!requested.has(resolved)) {
    requested.add(resolved)
    void load().then((mod) => {
      highlighter().loadLanguageSync(mod.default)
      const state = grammarLoadState(resolved)
      state.count += 1
      for (const listener of state.listeners) listener()
    })
  }
  return false
}

// Engine + grammar construction costs a long task (~120-175ms); building it
// during the first finalized fence's render would jank exactly when a stream
// completes. Warm the singleton in a deferred task at module load (= plugin
// boot) instead; the lazy path above stays as the correctness fallback for a
// fence that renders before the timer fires. `unref` (Node-only) keeps a
// non-browser import from pinning the event loop.
const warmupTimer = setTimeout(() => { highlighter() }, 0)
;(warmupTimer as { unref?: () => void }).unref?.()

/**
 * Highlight `code` into shiki's HTML (a single `<pre class="shiki">` tree)
 * when `lang` maps to a registered grammar; `undefined` means the caller
 * renders its plain fallback. A lazy grammar not yet loaded returns `undefined`
 * for this call and loads in the background; subscribe with
 * {@link grammarLoadSource} to re-highlight once it registers. Sources longer
 * than {@link HighlightConfig.maxSourceChars} report `undefined` without
 * tokenizing and without requesting a grammar. Results are retained in a
 * bounded cache, so repeated renders of the same fence cost one lookup.
 * @param code - the source text.
 * @param lang - the language hint (a markdown fence info string or a fixed caller id).
 * @returns the highlighted HTML, or `undefined` for unknown, over-cap, or not-yet-loaded languages.
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = resolveGrammar(lang)
  if (resolved === undefined) return undefined
  if (code.length > activeConfig.maxSourceChars) return undefined
  const key = cacheKey(resolved, code)
  const cached = htmlCache.get(key)
  if (cached !== undefined) return cached
  if (!ensureGrammar(resolved)) return undefined
  const html = highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' })
  htmlCache.set(key, html)
  return html
}

/**
 * One highlighted run of a line: the text and the inline style shiki assigned
 * it. The css-variables theme colors every run through a `--shiki-*` custom
 * property, so `style.color` is always present; it is held as a style object
 * rather than a bare color so a run spreads onto a `<span style>` uniformly.
 */
export interface HighlightSpan {
  text: string
  style: CSSProperties
}

/**
 * Tokenize `code` into per-line highlighted runs when `lang` maps to a
 * registered grammar; `undefined` means the caller renders its plain fallback.
 * A line-numbered view needs the token runs split per line (one gutter number
 * per line), which the single-`<pre>` {@link highlightToHtml} does not expose,
 * so this returns shiki's own 2D line/token structure narrowed to what a run
 * renders. Each run's color is a `--shiki-*` custom property, keeping token
 * colors on the theme package's sheets exactly as the HTML path does; the
 * css-variables theme carries no font-style bits, matching that path's
 * color-only output. The trailing newline shiki appends as a final empty line
 * is dropped so the run count matches the caller's own line array.
 * Sources longer than {@link HighlightConfig.maxSourceChars} report
 * `undefined` without tokenizing, and results are retained in a bounded cache.
 * @param code - the source text.
 * @param lang - the language hint (a file-extension-derived language id).
 * @returns one entry per source line (each an array of runs), or `undefined` for unknown, over-cap, or not-yet-loaded languages.
 */
export function highlightLines(code: string, lang: string | undefined): HighlightSpan[][] | undefined {
  const resolved = resolveGrammar(lang)
  if (resolved === undefined) return undefined
  if (code.length > activeConfig.maxSourceChars) return undefined
  const key = cacheKey(resolved, code)
  const cached = lineCache.get(key)
  if (cached !== undefined) return cached
  if (!ensureGrammar(resolved)) return undefined
  const { tokens } = highlighter().codeToTokens(code, { lang: resolved, theme: 'css-variables' })
  // shiki tokenizes `a\nb` into two lines; a trailing newline (`a\n`) adds a
  // third, empty line the caller's own line array does not carry. Drop that
  // one terminator line so the two structures stay in step. The explicit
  // `last !== undefined` (over `tokens[...]?.length`) keeps a single branch for
  // per-file coverage, matching TerminalBlock's terminator check.
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0
    ? tokens.slice(0, -1)
    : tokens
  const runs = lines.map(line => line.map(token => ({ text: token.content, style: { color: token.color } })))
  lineCache.set(key, runs)
  return runs
}

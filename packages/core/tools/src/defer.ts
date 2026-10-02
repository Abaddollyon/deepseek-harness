/**
 * Deferred tool declarations: which visible tools a scope lists by name only,
 * the compact index that replaces their full declarations, and the keyword
 * search `tool_search` runs over them.
 * @module @deepseek-ai/dsh-tools/src/defer
 */

/** The model-facing name of the declaration lookup tool. */
export const TOOL_SEARCH_NAME = 'tool_search'

/** Maximum number of tools one `tool_search` call returns. */
export const TOOL_SEARCH_LIMIT = 10

/** Longest one-line description an index entry keeps, in characters. */
const INDEX_DESCRIPTION_LIMIT = 100

/** A group with more members than this prints its names on one line. */
const INDEX_GROUP_LINE_THRESHOLD = 8

/**
 * Which visible tools a scope defers. A tool is deferred when its definition
 * sets `deferLoading` or its name matches `include`, and its name matches no
 * `exclude` pattern. Patterns match whole tool names; `*` matches any run of
 * characters, including none.
 */
export interface ToolDeferPolicy {
  /** Name patterns of tools listed by name only. */
  readonly include?: readonly string[]
  /** Name patterns kept fully declared even when `include` or `deferLoading` defers them. */
  readonly exclude?: readonly string[]
}

/** The `defer` config field: a {@link ToolDeferPolicy} as configuration writes it. */
export interface ToolDeferConfig {
  /** Name patterns of tools listed by name only. */
  include?: string[]
  /** Name patterns kept fully declared. */
  exclude?: string[]
}

/** A policy compiled once for repeated name tests. */
export interface CompiledToolDeferPolicy {
  /**
   * Decide one tool.
   * @param name - the tool's registered name.
   * @param deferLoading - the definition's own `deferLoading` flag.
   * @returns whether the tool is listed by name only.
   */
  defers(name: string, deferLoading: boolean): boolean
}

/** One deferred tool as the index lists it. */
export interface DeferredToolEntry {
  readonly name: string
  readonly description: string
}

/**
 * Order tools by name in code-unit order, the order every SDK rendering uses.
 * @param a - one tool.
 * @param b - another tool.
 * @returns a negative, zero, or positive comparison.
 */
export function byToolName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Compile one `*` pattern into an anchored expression. */
function patternExpression(pattern: string): RegExp {
  if (pattern.length === 0) throw new Error('tool defer pattern must be a non-empty string')
  const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('.*')
  return new RegExp(`^${source}$`, 'u')
}

/**
 * Compile a defer policy.
 * @param policy - the include and exclude name patterns.
 * @returns the compiled policy.
 * @throws when a pattern is empty.
 */
export function compileToolDeferPolicy(policy: ToolDeferPolicy): CompiledToolDeferPolicy {
  const include = (policy.include ?? []).map(patternExpression)
  const exclude = (policy.exclude ?? []).map(patternExpression)
  return {
    defers(name, deferLoading) {
      if (!deferLoading && !include.some(pattern => pattern.test(name))) return false
      return !exclude.some(pattern => pattern.test(name))
    },
  }
}

/**
 * The first sentence of a description on one line, capped for the index.
 * @param description - the tool description.
 * @returns the sentence, or the capped prefix when no sentence ends early.
 */
export function firstSentence(description: string): string {
  const collapsed = description.replace(/\s+/gu, ' ').trim()
  const end = collapsed.search(/[.!?](?:\s|$)/u)
  const sentence = end < 0 ? collapsed : collapsed.slice(0, end + 1)
  return sentence.length <= INDEX_DESCRIPTION_LIMIT ? sentence : `${sentence.slice(0, INDEX_DESCRIPTION_LIMIT - 1).trimEnd()}…`
}

/**
 * The family a tool name belongs to in the index: the MCP server for
 * `mcp__<server>__<tool>`, the part before the first `__` for other
 * namespaced names, and the name itself otherwise.
 * @param name - the tool name.
 * @returns the group prefix, or undefined for an unnamespaced tool.
 */
function groupPrefix(name: string): string | undefined {
  const parts = name.split('__')
  if (parts.length < 2) return undefined
  if (parts[0] === 'mcp' && parts.length >= 3) return `${parts[0]}__${parts[1]}`
  return parts[0]
}

/**
 * Render the index lines for deferred tools. A namespaced family larger than
 * {@link INDEX_GROUP_LINE_THRESHOLD} becomes one line of its member names;
 * every other tool gets a line with its first sentence.
 * @param sorted - the deferred tools in name order.
 * @returns the Markdown list lines.
 */
function indexLines(sorted: readonly DeferredToolEntry[]): string[] {
  const groups = new Map<string, DeferredToolEntry[]>()
  for (const entry of sorted) {
    const prefix = groupPrefix(entry.name)
    if (prefix === undefined) continue
    groups.set(prefix, [...groups.get(prefix) ?? [], entry])
  }
  const lines: string[] = []
  const emitted = new Set<string>()
  for (const entry of sorted) {
    const prefix = groupPrefix(entry.name)
    const group = prefix === undefined ? undefined : groups.get(prefix)
    if (prefix !== undefined && group !== undefined && group.length > INDEX_GROUP_LINE_THRESHOLD) {
      if (emitted.has(prefix)) continue
      emitted.add(prefix)
      const members = group.map(member => member.name.slice(prefix.length + 2)).join(', ')
      lines.push(`- \`${prefix}__*\` (${String(group.length)} tools): ${members}`)
      continue
    }
    const sentence = firstSentence(entry.description)
    lines.push(sentence.length > 0 ? `- \`${entry.name}\` — ${sentence}` : `- \`${entry.name}\``)
  }
  return lines
}

/**
 * Render the index that follows the SDK declarations when a scope defers tools.
 * @param entries - the deferred tools; empty renders nothing.
 * @param call - renders one example `tool_search` call in the SDK's language for a tool name.
 * @returns the section text, or the empty string without deferred tools.
 */
export function renderDeferredIndex(entries: readonly DeferredToolEntry[], call: (example: string) => string): string {
  const sorted = [...entries].sort(byToolName)
  const [first] = sorted
  if (first === undefined) return ''
  return [
    '## More tools',
    '',
    `These tools are callable from the program but not declared above. Before you call one, look up its declaration with \`${TOOL_SEARCH_NAME}\` (exact \`names\`, or a keyword \`query\`) and print it, for example \`${call(first.name)}\`.`,
    '',
    ...indexLines(sorted),
  ].join('\n')
}

/**
 * Select tools for one `tool_search` call. Exact names come first in the
 * order asked; a query matches tools whose name or description contains every
 * whitespace-separated term (case-insensitive), names before descriptions.
 * @param candidates - the tools the caller may look up.
 * @param names - exact tool names.
 * @param query - keywords.
 * @returns the selected tools (at most {@link TOOL_SEARCH_LIMIT}) and the names that matched nothing.
 */
export function searchTools<T extends DeferredToolEntry>(
  candidates: readonly T[],
  names: readonly string[] | undefined,
  query: string | undefined,
): { readonly found: T[]; readonly unknown: string[] } {
  const byName = new Map(candidates.map(candidate => [candidate.name, candidate]))
  const found: T[] = []
  const unknown: string[] = []
  const add = (candidate: T): void => {
    if (found.length < TOOL_SEARCH_LIMIT && !found.includes(candidate)) found.push(candidate)
  }
  for (const name of names ?? []) {
    const candidate = byName.get(name)
    if (candidate === undefined) unknown.push(name)
    else add(candidate)
  }
  const terms = (query ?? '').toLowerCase().split(/\s+/u).filter(term => term.length > 0)
  if (terms.length > 0) {
    const sorted = [...candidates].sort(byToolName)
    const matches = (text: string): boolean => terms.every(term => text.toLowerCase().includes(term))
    for (const candidate of sorted) if (matches(candidate.name)) add(candidate)
    for (const candidate of sorted) if (matches(`${candidate.name} ${candidate.description}`)) add(candidate)
  }
  return { found, unknown }
}

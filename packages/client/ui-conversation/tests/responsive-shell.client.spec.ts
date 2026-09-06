import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const css = readFileSync(fileURLToPath(new URL(
  '../src/client/skeleton/ConversationRoot.module.css', import.meta.url,
)), 'utf8')

function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const values = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) values.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
    }
    return values
  }
}

describe('ConversationRoot responsive interaction ownership', () => {
  test('keeps the root non-scrollable while the tab strip owns horizontal focus reveal', () => {
    expect(declarations(".root[data-phase='active']")?.get('overflow')).toBe('clip')
    expect(declarations('.tabs')?.get('overflow-x')).toBe('auto')
    expect(declarations('.tabs')?.get('overflow-y')).toBe('hidden')
    expect(declarations('.tab')?.get('flex')).toBe('none')
  })

  test('width handles accept hit testing only for the Chat view', () => {
    expect(declarations('.widthHandle')?.get('display')).toBe('none')
    expect(declarations(".root:has(.header[data-active-view='chat']) .widthHandle")?.get('display')).toBe('block')
  })

  test('stacks and wraps Session header metadata in compact columns', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 640px)'))
    expect(compact).toContain('flex-direction: column')
    expect(compact).toContain('.headerActions,\n  .headerUtilities')
    expect(compact).toContain('flex-wrap: wrap')
    expect(compact).toContain('margin-left: 0')
  })
})

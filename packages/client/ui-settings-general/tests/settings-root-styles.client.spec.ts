import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

/** The declarations of one base rule, by selector. */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`SettingsRoot.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('SettingsRoot responsive layout', () => {
  it('keeps the desktop panel and navigation rail dimensions', () => {
    expect(block('.panel')).toContain('width: 800px')
    expect(block('.panel')).toContain('max-width: calc(100vw - 48px)')
    expect(block('.nav')).toContain('flex-direction: column')
    expect(block('.nav')).toContain('width: 188px')
  })

  it('uses a bounded single-column panel at the narrow breakpoint', () => {
    const narrow = /@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? ''

    expect(narrow).toMatch(/\.panel\s*\{[^}]*flex-direction:\s*column/)
    expect(narrow).toMatch(/\.panel\s*\{[^}]*width:\s*calc\(100vw - 24px\)/)
    expect(narrow).toMatch(/\.panel\s*\{[^}]*height:\s*calc\(100vh - 24px\)/)
    expect(narrow).toMatch(/\.content\s*\{[^}]*min-height:\s*0/)
  })

  it('puts the narrow navigation above the vertically scrolling section', () => {
    const narrow = /@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? ''

    expect(narrow).toMatch(/\.nav\s*\{[^}]*width:\s*100%/)
    expect(narrow).toMatch(/\.navList\s*\{[^}]*flex-direction:\s*row/)
    expect(narrow).toMatch(/\.navList\s*\{[^}]*overflow-x:\s*auto/)
    expect(narrow).toMatch(/\.navCell\s*\{[^}]*flex:\s*none/)
    expect(block('.options')).toContain('overflow-y: auto')
  })
})

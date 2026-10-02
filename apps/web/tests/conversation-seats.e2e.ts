/** Real profile, Remote and slots: a dynamic package fills the Conversation landing and aside seats. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-conversation-seats', import.meta.url))

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (value === null) throw new Error('element has no layout box')
  return value
}

it('shows the preset landing above the docked composer and an aside beside the whole Conversation', async () => {
  const scaffold = await launchWebScaffold({
    agentPresets: { default: 'standard' },
    extraInstallAnchors: [join(FIXTURE, 'package.json')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1440, height: 900 })
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-seats'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // A loose blank Session runs the default `standard` preset.
    await page.getByRole('button', { name: 'Choose workspace' }).click()
    await page.getByRole('menuitem', { name: 'Don’t use a workspace' }).click()
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 15_000 })
    const phase = page.locator('[data-phase]:has([data-conversation-content])')
    expect(await phase.getAttribute('data-phase')).toBe('hero')

    const entryId = await scaffold.ctx.loader.create({ name: '@fixture/conversation-seats' })
    const landing = page.locator('[data-fixture-landing="standard"]')
    const aside = page.locator('[data-fixture-aside="standard"]')
    await landing.waitFor()
    await aside.waitFor()
    await expect.poll(() => phase.getAttribute('data-phase')).toBe('active')
    expect(await page.getByText('Fixture landing').count()).toBe(1)

    // The landing fills the band above the docked composer; the aside spans
    // the Conversation's full height to its right.
    const seat = await box(page.locator('[data-composer-seat]'))
    const landingBox = await box(landing)
    expect(landingBox.y + landingBox.height).toBeLessThanOrEqual(seat.y + 1)
    const conversation = await box(phase)
    const asideBox = await box(aside)
    expect(asideBox.x).toBeGreaterThanOrEqual(conversation.x + conversation.width - 1)
    expect(asideBox.width).toBe(280)
    expect(Math.abs(asideBox.y - conversation.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(asideBox.height - conversation.height)).toBeLessThanOrEqual(1)

    // Unloading the package restores the Hero and gives the width back.
    scaffold.ctx.loader.remove(entryId)
    await expect.poll(() => aside.count()).toBe(0)
    await expect.poll(() => phase.getAttribute('data-phase')).toBe('hero')
    expect(await landing.count()).toBe(0)
    expect(console.pageErrors).toEqual([])
  } finally {
    await browser.close()
  }
})

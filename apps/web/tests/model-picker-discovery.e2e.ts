// Real-browser proof for the shared model-picker refresh surface. The scenario
// makes zero model calls and uses only fake, unauthenticated provider routes.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))
const DESKTOP_SHOT = '/tmp/dsh-model-picker-desktop.png'
const NARROW_SHOT = '/tmp/dsh-model-picker-narrow.png'
const DESKTOP_FULL_SHOT = '/tmp/dsh-model-picker-desktop-full.png'
const NARROW_FULL_SHOT = '/tmp/dsh-model-picker-narrow-full.png'
const ARIA_RECEIPT = '/tmp/dsh-model-picker-aria.md'

describe('web e2e: model picker search and refresh', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    const settings = (scaffold.ctx as unknown as {
      settings: { update(namespace: string, value: unknown): Promise<unknown> }
    }).settings
    await settings.update('llm-pi-ai', {
      providers: {
        'origin-gateway': {
          displayName: 'Origin Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.origin.invalid/v1',
          models: [{ id: 'origin-large', name: 'Origin Large' }],
        },
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.invalid/v1',
          models: [{ id: 'acme-large', name: 'Acme Large' }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('types search, traverses by keyboard, backs out, refreshes, and fits narrow screens', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-picker-discovery'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /模型/ }).click()

    const menu = page.getByRole('menu', { name: '模型与推理等级' })
    const search = menu.getByRole('searchbox', { name: '搜索模型或提供方' })
    await search.focus()
    await search.pressSequentially('acme', { delay: 35 })
    await expect.poll(() => search.inputValue()).toBe('acme')
    const acme = menu.getByRole('menuitemradio', { name: 'Acme Large' })
    await acme.waitFor()
    expect(await menu.getByRole('menuitemradio', { name: 'Origin Large' }).count()).toBe(0)

    await search.press('ArrowDown')
    await expect.poll(() => acme.evaluate(node => node === document.activeElement)).toBe(true)
    await page.screenshot({ path: DESKTOP_FULL_SHOT })
    await menu.screenshot({ path: DESKTOP_SHOT })

    await acme.press('Escape')
    expect(await menu.getByRole('searchbox').count()).toBe(0)
    const modelRoot = menu.getByRole('menuitem', { name: /模型/ })
    await modelRoot.focus()
    await modelRoot.press('Escape')
    await expect.poll(() => trigger.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => trigger.evaluate(node => node === document.activeElement)).toBe(true)

    await trigger.click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    const refresh = menu.getByRole('button', { name: '刷新模型' })
    await refresh.click()
    await expect.poll(() => refresh.isEnabled(), { timeout: 15_000 }).toBe(true)
    await menu.getByRole('menuitemradio', { name: 'Origin Large' }).waitFor()

    await page.setViewportSize({ width: 390, height: 844 })
    const narrowSearch = menu.getByRole('searchbox', { name: '搜索模型或提供方' })
    await narrowSearch.focus()
    await narrowSearch.pressSequentially('origin', { delay: 35 })
    await expect.poll(() => narrowSearch.inputValue()).toBe('origin')
    const box = await menu.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: NARROW_FULL_SHOT })
    await menu.screenshot({ path: NARROW_SHOT })
    await writeFile(ARIA_RECEIPT, `${await menu.ariaSnapshot()}\n`)

    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})

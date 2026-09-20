// Real browser + Loader + durable Workspace/Session acceptance. No live provider calls.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-workspace'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

it('creates and edits one multi-root workspace durably without changing existing sessions or Chats', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-multi-root-web-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let failurePage: Page | undefined
  const failures: unknown[] = []
  try {
    const override = join(fixture, 'replay.json')
    await writeFile(override, JSON.stringify([{ kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'MULTI_ROOT_SAVED' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'MULTI_ROOT_SAVED' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] }]))
    const active = await launchWebScaffold({ replayFixture: join(fixture, 'override-only.jsonl'), replayOverride: override })
    scaffold = active
    const registry = active.ctx.workspaceRegistry
    const primary = join(active.workspaceCwd, 'primary-root')
    const side = join(active.workspaceCwd, 'side-root')
    await mkdir(primary)
    await mkdir(side)
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    failurePage = page
    const tripwire = watchConsole(page)
    await page.goto(active.authenticatedUrl, { waitUntil: 'load' })

    const chooseFolder = async (page: Page, path: string): Promise<void> => {
      const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: 'Edit path', exact: true }).click()
      const input = dialog.getByRole('textbox', { name: 'Edit path', exact: true })
      await input.fill(path)
      await page.keyboard.press('Enter')
      await input.waitFor({ state: 'detached' })
      await dialog.getByRole('button', { name: 'Open', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }

    await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
    await chooseFolder(page, primary)
    const draft = page.getByRole('dialog', { name: 'Create workspace', exact: true })
    await draft.getByRole('button', { name: 'Add folder', exact: true }).click()
    await chooseFolder(page, side)
    expect(await draft.getByText(side, { exact: true }).count()).toBe(1)
    await expect(registry.resolveByPath(primary)).resolves.toBeUndefined()
    await draft.getByRole('button', { name: 'Create workspace', exact: true }).click()
    await expect.poll(async () => (await registry.resolveByPath(primary))?.additionalPaths).toEqual([side])
    await expect.poll(() => active.ctx.agents.list()
      .find(agent => agent.session.header.cwd === primary)?.session.additionalPaths).toEqual([side])
    const session = active.ctx.agents.list().find(agent => agent.session.header.cwd === primary)!.session
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await composer.fill('Remember this multi-root session. Reply MULTI_ROOT_SAVED.')
    const settled = active.whenTurnSettled()
    await composer.press('Enter')
    await settled
    await page.getByText('MULTI_ROOT_SAVED', { exact: true }).waitFor({ timeout: 30_000 })

    const row = page.getByRole('treeitem').filter({ has: page.getByText('primary-root', { exact: true }) }).first()
    const actions = row.getByRole('button', { name: 'Workspace actions for primary-root' })
    await row.hover()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Manage folders', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Manage folders', exact: true })
    await editor.getByRole('button', { name: 'Remove folder ' + side, exact: true }).click()
    await editor.getByRole('button', { name: 'Save folders', exact: true }).click()
    await expect.poll(async () => (await registry.resolveByPath(primary))?.additionalPaths).toEqual([])
    expect(session.additionalPaths).toEqual([side])
    await editor.waitFor({ state: 'hidden' })

    // Preserve a deliberate fold across a reload with this workspace still selected.
    if (await row.getAttribute('aria-expanded') === 'true') await row.click()
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Add workspace', exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const restored = page.getByRole('treeitem').filter({ has: page.getByText('primary-root', { exact: true }) }).first()
    await expect.poll(() => restored.getAttribute('aria-expanded')).toBe('false')
    await expect(registry.resolveByPath(primary)).resolves.toMatchObject({ additionalPaths: [] })
    expect(session.additionalPaths).toEqual([side])
    expect((await readPersistedEvents(active, session.id))
      .filter(event => event.type === 'workspace/roots')
      .map(event => event.data.additionalPaths)).toEqual([[side]])

    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: "Don't use a workspace", exact: true }).click()
    await page.getByText('Chats', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    failures.push(error)
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-workspace-roots')
  } finally {
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(fixture, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'multi-root browser acceptance and cleanup failed')
}, 120_000)

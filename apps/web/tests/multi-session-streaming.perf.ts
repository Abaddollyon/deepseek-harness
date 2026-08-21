// Opt-in browser diagnostic for the three-session streaming jitter report.
// It prints timing distributions without timing assertions; structural checks
// keep the concurrency, streamed turns, tool history, and visible rows intact.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SESSION_COUNT = 3
const SEEDED_TURNS = 8
const STREAM_DELTAS = 240
const STREAM_PACE_MS = 12
const HOST_SAMPLES = 24
const HOST_SAMPLE_INTERVAL_MS = 100
const SESSION_IDS = Array.from({ length: SESSION_COUNT }, (_, index) =>
  SessionId(`multi-stream-perf-${String(index + 1)}`))
const SESSION_TITLES = Array.from({ length: SESSION_COUNT }, (_, index) =>
  `JITTER Session ${String(index + 1)}`)
const STREAM_MARKER = 'MULTI_SESSION_STREAM_DONE'

interface FrameCadence {
  readonly frames: number
  readonly longFrames: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly maxMs: number
  readonly histogram: Readonly<Record<string, number>>
}

interface HostSample {
  readonly wallMs: number
  readonly status: number
}

interface InteractionMeasurements {
  readonly sidebarSwitchMs: number
  readonly selectorRowsMs: number
  readonly newSessionFirstRenderMs: number
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0
}

function textStream(): StreamChunk[] {
  const deltas = Array.from({ length: STREAM_DELTAS }, (_, index) => {
    if (index === STREAM_DELTAS - 1) return `${STREAM_MARKER} final chunk.`
    return `stream chunk ${String(index).padStart(3, '0')} keeps all three sessions active. `
  })
  const response = deltas.join('')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    {
      type: 'usage',
      usage: { inputTokens: 512, outputTokens: Math.ceil(response.length / 4) },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function replayOverride(): ReplayOverrideDoc {
  return Array.from({ length: SESSION_COUNT }, (): ReplayEntry => ({
    kind: 'chunks',
    chunks: textStream(),
  }))
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function openSessionBySearch(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Search sessions' }).click()
  const input = page.getByPlaceholder('Search sessions', { exact: false })
  await input.waitFor({ timeout: 15_000 })
  await input.fill(title)
  const row = page.getByRole('treeitem').filter({ hasText: title }).first()
  await row.waitFor({ timeout: 15_000 })
  await row.click()
}

async function installFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Probe {
      intervals: number[]
      last: number | null
      raf: number
    }
    const owner = window as unknown as { __multiSessionFrameProbe?: Probe }
    const probe: Probe = { intervals: [], last: null, raf: 0 }
    const tick = (time: number): void => {
      if (probe.last !== null) probe.intervals.push(time - probe.last)
      probe.last = time
      probe.raf = requestAnimationFrame(tick)
    }
    probe.raf = requestAnimationFrame(tick)
    owner.__multiSessionFrameProbe = probe
  })
}

async function collectFrameCadence(page: Page): Promise<FrameCadence> {
  const intervals = await page.evaluate(() => {
    const owner = window as unknown as {
      __multiSessionFrameProbe?: { intervals: number[]; raf: number }
    }
    const probe = owner.__multiSessionFrameProbe
    if (probe === undefined) throw new Error('multi-session frame probe is not installed')
    cancelAnimationFrame(probe.raf)
    return [...probe.intervals]
  })
  const sorted = [...intervals].sort((left, right) => left - right)
  const histogram: Record<string, number> = {
    '<=17ms': 0,
    '17-25ms': 0,
    '25-50ms': 0,
    '50-100ms': 0,
    '>100ms': 0,
  }
  for (const interval of intervals) {
    if (interval <= 17) histogram['<=17ms']! += 1
    else if (interval <= 25) histogram['17-25ms']! += 1
    else if (interval <= 50) histogram['25-50ms']! += 1
    else if (interval <= 100) histogram['50-100ms']! += 1
    else histogram['>100ms']! += 1
  }
  return {
    frames: intervals.length,
    longFrames: intervals.filter(interval => interval > 50).length,
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99)),
    maxMs: rounded(sorted.at(-1) ?? 0),
    histogram,
  }
}

async function sampleHost(baseUrl: string): Promise<HostSample[]> {
  const samples: HostSample[] = []
  for (let index = 0; index < HOST_SAMPLES; index += 1) {
    const started = performance.now()
    const response = await fetch(baseUrl, { cache: 'no-store' })
    samples.push({ wallMs: rounded(performance.now() - started), status: response.status })
    await response.body?.cancel()
    if (index + 1 < HOST_SAMPLES) await delay(HOST_SAMPLE_INTERVAL_MS)
  }
  return samples
}

function hostSummary(samples: readonly HostSample[]): Record<string, number> {
  const sorted = samples.map(sample => sample.wallMs).sort((left, right) => left - right)
  return {
    samples: sorted.length,
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(sorted.at(-1) ?? 0),
  }
}

async function measureInteractions(
  page: Page,
  scaffold: WebScaffold,
  targetMarker: string,
): Promise<InteractionMeasurements> {
  const tree = page.getByRole('tree', { name: 'Sessions' })
  const group = tree.locator('[role="treeitem"][aria-expanded]')
    .filter({ hasText: basename(scaffold.workspaceCwd) }).first()
  await group.waitFor({ timeout: 15_000 })
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()

  const targetRow = tree.getByRole('treeitem').filter({ hasText: SESSION_TITLES[1]! }).first()
  await targetRow.waitFor({ timeout: 15_000 })
  const switchStarted = performance.now()
  await targetRow.click()
  await page.getByText(targetMarker, { exact: false }).waitFor({ timeout: 15_000 })
  const sidebarSwitchMs = rounded(performance.now() - switchStarted)

  const selectorStarted = performance.now()
  await page.getByRole('button', { name: 'Search sessions' }).click()
  const input = page.getByPlaceholder('Search sessions', { exact: false })
  await input.waitFor({ timeout: 15_000 })
  await input.fill('JITTER Session')
  const resultRows = page.getByRole('treeitem').filter({ hasText: 'JITTER Session' })
  await expect.poll(() => resultRows.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(SESSION_COUNT)
  const selectorRowsMs = rounded(performance.now() - selectorStarted)
  await input.press('Escape')

  const newStarted = performance.now()
  await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
  await page.getByText('Into the Unknown', { exact: false }).waitFor({ timeout: 15_000 })
  const newSessionFirstRenderMs = rounded(performance.now() - newStarted)
  return { sidebarSwitchMs, selectorRowsMs, newSessionFirstRenderMs }
}

async function startConcurrentTurns(scaffold: WebScaffold): Promise<void> {
  const responses = await Promise.all(SESSION_IDS.map((sessionId, index) =>
    scaffold.ctx.apiProxy.sessions.prompt({
      rpcId: `multi-stream-prompt-${String(index + 1)}` as never,
      payload: {
        sessionId,
        mode: 'queue' as const,
        content: [{
          type: 'text' as const,
          text: `MULTI_SESSION_STREAM_PROMPT_${String(index + 1)} keep streaming while the GUI is measured.`,
        }],
      },
    })))
  expect(responses.every(response => response.result.ok)).toBe(true)
}

describe('web performance: three concurrent streaming sessions', () => {
  it('reports frame, interaction, host, and fresh-session latency', async () => {
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    let replayDir: string | undefined
    try {
      replayDir = await mkdtemp(join(tmpdir(), 'dsh-multi-stream-perf-'))
      const replayPath = join(replayDir, 'replay.override.json')
      await writeFile(replayPath, JSON.stringify(replayOverride()))
      scaffold = await launchWebScaffold({ replayOverride: replayPath, paceMs: STREAM_PACE_MS })
      const fixtures = SESSION_TITLES.map((title, index) => createChatScrollFixture({
        markerPrefix: `JITTER_${String(index + 1)}`,
        title,
        turns: SEEDED_TURNS,
      }))
      for (let index = 0; index < SESSION_COUNT; index += 1) {
        await seedSession(scaffold, fixtures[index]!.log, SESSION_IDS[index]!)
      }
      const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
      for (const sessionId of SESSION_IDS) await workspace.attachSession(sessionId)

      browser = await chromium.launch({ headless: true })
      page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await openSessionBySearch(page, SESSION_TITLES[0]!)
      await page.getByText(fixtures[0]!.markers.assistant(SEEDED_TURNS), { exact: false })
        .waitFor({ timeout: 30_000 })

      expect(await scaffold.ctx.sessionPersistence.list()).toHaveLength(SESSION_COUNT)
      await installFrameProbe(page)
      const hostSamplesPromise = sampleHost(scaffold.baseUrl)
      await startConcurrentTurns(scaffold)
      await expect.poll(() => SESSION_IDS.filter(id => scaffold!.ctx.agents.get(id)?.status === 'running').length,
        { timeout: 15_000 }).toBe(SESSION_COUNT)
      const interactions = await measureInteractions(
        page,
        scaffold,
        fixtures[1]!.markers.assistant(SEEDED_TURNS),
      )

      const hostSamples = await hostSamplesPromise
      await expect.poll(() => SESSION_IDS.filter(id => scaffold!.ctx.agents.get(id)?.status === 'running').length,
        { timeout: 30_000 }).toBe(0)
      const frameCadence = await collectFrameCadence(page)

      const streamedTurns = SESSION_IDS.map((id) => {
        const agent = scaffold!.ctx.agents.get(id)
        expect(agent).toBeDefined()
        return agent!.session.events.filter(event => event.type === 'turn/end').length
      })
      expect(streamedTurns).toEqual(Array.from({ length: SESSION_COUNT }, () => SEEDED_TURNS + 1))
      expect(SESSION_IDS.map(id => scaffold!.ctx.agents.get(id)!.session.events
        .filter(event => event.type === 'tool/call').length))
        .toEqual(Array.from({ length: SESSION_COUNT }, () => 2))
      expect(await scaffold.ctx.sessionPersistence.list()).toHaveLength(SESSION_COUNT)
      expect(await page.getByRole('tree', { name: 'Sessions' }).count()).toBe(1)
      expect(hostSamples.every(sample => sample.status === 200)).toBe(true)
      expect(frameCadence.frames).toBeGreaterThan(0)
      expect(tripwire.pageErrors).toEqual([])

      console.log('[multi-session-streaming.perf]', JSON.stringify({
        scenario: {
          concurrentSessions: SESSION_COUNT,
          seededTurnsPerSession: SEEDED_TURNS,
          streamedTurnsPerSession: 1,
          deltasPerStream: STREAM_DELTAS,
          paceMs: STREAM_PACE_MS,
        },
        frameCadence,
        interactions,
        hostResponsiveness: hostSummary(hostSamples),
      }, null, 2))
    } finally {
      await page?.close().catch(() => undefined)
      await browser?.close().catch(() => undefined)
      try {
        await scaffold?.close()
      } finally {
        if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
      }
    }
  }, 120_000)
})

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface CompatibilityJob {
  'runs-on': string
  if: string
  env: Record<string, string>
  strategy: { 'fail-fast': boolean; matrix: { include: Array<{ node: string | number; name: string; runner: string; gate_concurrency: string }> } }
  steps: Step[]
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8')) as {
  jobs: { 'node-compat': CompatibilityJob; 'python-sdk': { 'runs-on': string } }
}
const job = workflow.jobs['node-compat']

// Equal-typed, canonical-case fixtures; this is not a complete Actions evaluator.
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const body = expression.trim().slice(3, -2)
  return runInNewContext(body, { ...context, fromJSON: JSON.parse }, { timeout: 1000 }) as unknown
}

describe('Node compatibility hosted routing', () => {
  it('keeps every compatibility entry hosted regardless of failover settings or PR origin', () => {
    expect(job['runs-on']).toBe('${{ matrix.runner }}')
    for (const mode of ['', 'selfhosted', 'unexpected']) {
      for (const author of ['maintainer', 'dependabot[bot]']) {
        for (const repository of ['owner/repo', 'outsider/fork']) {
          for (const fork of [false, true]) {
            for (const entry of job.strategy.matrix.include) {
              const context = {
                vars: { DSH_CI_FAILOVER_LINUX: mode },
                github: {
                  repository: 'owner/repo', actor: 'maintainer',
                  event: { pull_request: {
                    user: { login: author },
                    head: { repo: { full_name: repository, fork } },
                  } },
                },
                matrix: entry,
              }
              expect(evaluate(job['runs-on'], context)).toBe('ubuntu-latest')
            }
          }
        }
      }
    }
  })

  it('preserves all three required version jobs and their concurrency', () => {
    expect(job.if).toBe("github.event_name == 'pull_request'")
    expect(job.strategy['fail-fast']).toBe(false)
    expect(job.strategy.matrix.include).toEqual([
      { node: '22.19', name: 'node 22.19', runner: 'ubuntu-latest', gate_concurrency: '1' },
      { node: '24.9', name: 'node 24.9', runner: 'ubuntu-latest', gate_concurrency: '1' },
      { node: 26, name: 'node 26', runner: 'ubuntu-latest', gate_concurrency: '1' },
    ])
    expect(job.env.DSH_GATE_CONCURRENCY).toBe('${{ matrix.gate_concurrency }}')
    expect(job.steps.map(step => step.run)).toContain('pnpm run check:node-compat')
    expect(job.steps.map(step => step.run)).toContain('pnpm exec vitest run packages/boot/app-boot/tests/loader-shape.compat.spec.ts')
    expect(workflow.jobs['python-sdk']['runs-on']).toBe('ubuntu-latest')
  })

  it('uses hosted package caching without private-runner setup', () => {
    const setup = job.steps.find(step => step.uses === 'actions/setup-node@v6')!
    expect(setup.env).toBeUndefined()
    expect(setup.with).toEqual({
      'node-version': '${{ matrix.node }}', cache: 'pnpm', 'package-manager-cache': false,
    })
    expect(job.steps[0]?.with).toEqual({ 'persist-credentials': false })
    expect(JSON.stringify(job)).not.toContain('self-hosted')
    expect(JSON.stringify(job)).not.toContain('ci-compatible-toolcache')
    expect(JSON.stringify(job)).not.toContain('NODE_OPTIONS')
    expect(job.steps.some(step => step.name === 'Isolate compatibility caches')).toBe(false)
    expect(job.steps.some(step => step.name === 'Verify isolated Node installation')).toBe(false)
    expect(job.steps.some(step => step.uses?.startsWith('actions/cache/'))).toBe(false)
  })
})

describe('Retained Node toolcache preload', () => {
  it('overrides runner exports only in a process explicitly importing the preload', () => {
    const nodeOptions = '--import=./scripts/ci-compatible-toolcache.mjs'
    const root = mkdtempSync(join(tmpdir(), 'ci-compatible preload-'))
    try {
      const env = { PATH: process.env.PATH, RUNNER_TEMP: root, RUNNER_TOOL_CACHE: join(root, 'persistent') }
      const probe = (options: Record<string, string | undefined>) => {
        const child = spawnSync(process.execPath, ['-p', 'process.env.RUNNER_TOOL_CACHE'], {
          cwd: resolve(import.meta.dirname, '..'), env: options, encoding: 'utf8', timeout: 10_000,
        })
        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        return child
      }
      const setupChild = probe({ ...env, NODE_OPTIONS: nodeOptions })
      expect(setupChild.status, setupChild.stderr).toBe(0)
      expect(setupChild.stdout.trim()).toBe(join(root, 'node-compat-toolcache'))
      const normalChild = probe(env)
      expect(normalChild.status, normalChild.stderr).toBe(0)
      expect(normalChild.stdout.trim()).toBe(env.RUNNER_TOOL_CACHE)
      const missingTemp = probe({ ...env, RUNNER_TEMP: undefined, NODE_OPTIONS: nodeOptions })
      expect(missingTemp.status).not.toBe(0)
      expect(missingTemp.stderr).toContain('requires an absolute RUNNER_TEMP')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

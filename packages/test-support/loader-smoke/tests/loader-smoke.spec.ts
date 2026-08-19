import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  WORKSPACE_PROJECT_ROOT_MARKER,
  anchorWorkspaceProjectRoot,
  isolatedSubprocessEnv,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const configPath = '/tmp/fixture.cordis.yml'
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))
// macOS realpaths temp dirs into /private; TMPDIR may live under /var or /tmp.
const canonicalTempPath = (path: string): string => path.replace(/^\/private(?=\/(?:var|tmp)\/)/, '')

describe('runLoaderSmoke', () => {
  it('isolates the process, closes stdin, captures output, and removes the cwd', async () => {
    const result = await runLoaderSmoke({
      label: 'success fixture',
      tempDirPrefix: 'loader-smoke-success-',
      binScript: fixture('success'),
      configPath,
      tsconfigPath,
      mode: 'src',
      env: { LOADER_SMOKE_MARKER: 'present' },
    })
    const output = JSON.parse(result.stdout) as {
      configPath: string
      args: string[]
      cwd: string
      dshHome: string
      agentsHome: string
      marker: string
      ambientDsh: string | null
      entries: string[]
      input: string
    }
    expect(output).toMatchObject({
      configPath,
      args: [configPath],
      marker: 'present',
      input: '',
    })
    expect(canonicalTempPath(output.dshHome)).toBe(canonicalTempPath(join(output.cwd, '.dsh')))
    expect(canonicalTempPath(output.agentsHome)).toBe(canonicalTempPath(join(output.cwd, '.agents')))
    expect(result.stderr).toContain('fixture stderr')
    expect(existsSync(output.cwd)).toBe(false)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('anchors the workspace as its own project root and hides ambient DSH deployment values', async () => {
    vi.stubEnv('DSH_LOADER_SMOKE_AMBIENT', 'leaked')
    try {
      const result = await runLoaderSmoke({
        label: 'hermetic fixture',
        tempDirPrefix: 'loader-smoke-hermetic-',
        binScript: fixture('success'),
        libBinScript: fixture('success'),
        configPath,
        tsconfigPath,
        env: { LOADER_SMOKE_MARKER: 'declared' },
      })
      const output = JSON.parse(result.stdout) as { entries: string[]; ambientDsh: string | null; marker: string }
      // The marker terminates instruction and skill discovery inside the generated cwd.
      expect(output.entries).toEqual([WORKSPACE_PROJECT_ROOT_MARKER])
      // A DSH_* value exported by the developer's shell never reaches the boot…
      expect(output.ambientDsh).toBeNull()
      // …while a value the test declares still does.
      expect(output.marker).toBe('declared')
    } finally {
      vi.unstubAllEnvs()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('passes an arbitrary bin argv and inspects world state before cleanup', async () => {
    let inspected = ''
    let marker = ''
    const result = await runLoaderSmoke({
      label: 'argv fixture',
      tempDirPrefix: 'loader-smoke-argv-',
      binScript: fixture('success'),
      libBinScript: fixture('success'),
      configPath,
      binArgs: ['--config', configPath, '--output-format', 'json', 'task with spaces'],
      tsconfigPath,
      prepare: cwd => writeFile(join(cwd, 'marker.txt'), 'prepared'),
      inspect: async (cwd) => {
        inspected = cwd
        marker = await readFile(join(cwd, 'marker.txt'), 'utf8')
      },
    })
    const output = JSON.parse(result.stdout) as { args: string[]; cwd: string }
    expect(output.args).toEqual(['--config', configPath, '--output-format', 'json', 'task with spaces'])
    expect(canonicalTempPath(inspected)).toBe(canonicalTempPath(output.cwd))
    expect(marker).toBe('prepared')
    expect(existsSync(inspected)).toBe(false)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('rejects a non-zero exit with captured diagnostics', async () => {
    await expect(runLoaderSmoke({
      label: 'failure fixture',
      tempDirPrefix: 'loader-smoke-fail-',
      binScript: fixture('fail'),
      libBinScript: fixture('fail'),
      configPath,
      tsconfigPath,
    })).rejects.toThrow('failure fixture exited 7 (expected 0). stdout:\n\nstderr:\nfixture failed')
  })

  it('accepts a declared expected failure exit and rejects any other outcome', async () => {
    // A scenario pinning a designed failure surface declares its exit code…
    const declared = await runLoaderSmoke({
      label: 'declared failure fixture',
      tempDirPrefix: 'loader-smoke-declared-fail-',
      binScript: fixture('fail'),
      libBinScript: fixture('fail'),
      configPath,
      tsconfigPath,
      expectedExitCode: 7,
    })
    expect(declared.stderr).toBe('fixture failed\n')

    // …and a run that succeeds instead still fails the smoke.
    await expect(runLoaderSmoke({
      label: 'unexpectedly clean fixture',
      tempDirPrefix: 'loader-smoke-clean-',
      binScript: fixture('success'),
      libBinScript: fixture('success'),
      configPath,
      tsconfigPath,
      expectedExitCode: 7,
    })).rejects.toThrow(/exited 0 \(expected 7\)/)
  })

  it('kills a process at its deadline and reports captured output', async () => {
    await expect(runLoaderSmoke({
      label: 'hanging fixture',
      tempDirPrefix: 'loader-smoke-hang-',
      binScript: fixture('hang'),
      libBinScript: fixture('hang'),
      configPath,
      tsconfigPath,
      processTimeoutMs: 100,
    })).rejects.toThrow('hanging fixture did not exit within 0.1s.')
  })
})

describe('hermetic workspace helpers', () => {
  it('anchors a project root idempotently', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'loader-smoke-anchor-'))
    try {
      await anchorWorkspaceProjectRoot(cwd)
      await anchorWorkspaceProjectRoot(cwd)
      expect((await stat(join(cwd, WORKSPACE_PROJECT_ROOT_MARKER))).isDirectory()).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('drops inherited DSH values, keeps the rest, and lets the launch declare its own', () => {
    const base = { PATH: '/usr/bin', DSH_PERMISSION_MODE: 'danger-full-access', DSH_HOME: '/home/dev/.dsh' }
    expect(isolatedSubprocessEnv({ DSH_HOME: '/run/cwd/.dsh' }, base)).toEqual({
      PATH: '/usr/bin',
      DSH_HOME: '/run/cwd/.dsh',
    })
  })
})

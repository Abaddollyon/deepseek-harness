import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ISOLATED_PROJECT_ROOT_MARKER,
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  isolateWorkspaceProjectRoot,
  resolveExampleLaunch,
  resolveExampleMode,
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

  it('anchors each subprocess in its requested root and creates the discovery marker', async () => {
    const parents = await Promise.all([
      mkdtemp(join(tmpdir(), 'dsh-loader-root-a-')),
      mkdtemp(join(tmpdir(), 'dsh-loader-root-b-')),
    ])
    try {
      const observed: string[] = []
      for (const [index, parent] of parents.entries()) {
        await runLoaderSmoke({
          label: `root fixture ${index}`,
          tempDirPrefix: `loader-smoke-root-${index}-`,
          tempDirParent: parent,
          binScript: fixture('success'),
          configPath,
          tsconfigPath,
          inspect: async (cwd) => {
            observed.push(cwd)
            expect((await stat(join(cwd, '.git'))).isDirectory()).toBe(true)
          },
        })
      }
      expect(observed).toHaveLength(2)
      expect(observed[0]).toContain(parents[0])
      expect(observed[1]).toContain(parents[1])
      expect(observed[0]).not.toBe(observed[1])
    } finally {
      await Promise.all(parents.map(parent => rm(parent, { recursive: true, force: true })))
    }
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

describe('launch resolver', () => {
  it('rejects an unknown mode and missing source tsconfig', () => {
    expect(() => resolveExampleMode('invalid')).toThrow('DSH_EXAMPLE_MODE')
    expect(() => resolveExampleLaunch({ srcBin: '/repo/src/bin.ts', mode: 'src' })).toThrow('needs tsconfigPath')
  })

  it('derives the plain Node lib entry in lib mode', () => {
    const launch = resolveExampleLaunch({ srcBin: '/repo/src/bin.ts', mode: 'lib' })
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual(['/repo/lib/bin.js'])
  })
})

describe('isolateWorkspaceProjectRoot', () => {
  it('creates the marker and keeps an existing real marker directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-isolate-root-'))
    try {
      await isolateWorkspaceProjectRoot(cwd)
      await isolateWorkspaceProjectRoot(cwd)
      const marker = await lstat(join(cwd, ISOLATED_PROJECT_ROOT_MARKER))
      expect(marker.isDirectory()).toBe(true)
      expect(marker.isSymbolicLink()).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked marker without following it into foreign state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-isolate-root-'))
    const foreign = await mkdtemp(join(tmpdir(), 'dsh-isolate-foreign-'))
    try {
      await symlink(foreign, join(cwd, ISOLATED_PROJECT_ROOT_MARKER))
      await expect(isolateWorkspaceProjectRoot(cwd)).rejects.toThrow('already exists as a symbolic link')
      // The harness neither replaced the link nor touched its target.
      expect((await lstat(join(cwd, ISOLATED_PROJECT_ROOT_MARKER))).isSymbolicLink()).toBe(true)
      expect(existsSync(foreign)).toBe(true)
    } finally {
      await Promise.all([cwd, foreign].map(dir => rm(dir, { recursive: true, force: true })))
    }
  })

  it('rejects a marker file planted by workspace setup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-isolate-root-'))
    try {
      await writeFile(join(cwd, ISOLATED_PROJECT_ROOT_MARKER), 'gitdir: ../elsewhere')
      await expect(isolateWorkspaceProjectRoot(cwd)).rejects.toThrow('already exists as a non-directory entry')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

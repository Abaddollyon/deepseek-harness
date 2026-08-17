import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { PiAiOAuthCredentialStore } from '../src/oauth-store.ts'

const roots: string[] = []

async function harness(): Promise<{ root: string; store: PiAiOAuthCredentialStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-ai-oauth-'))
  roots.push(root)
  return { root, store: new PiAiOAuthCredentialStore(join(root, 'credentials')) }
}

function oauth(access: string, extra: Record<string, unknown> = {}): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh: 'refresh-' + access,
    expires: Date.now() + 60_000,
    ...extra,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('PiAiOAuthCredentialStore', () => {
  it('persists, reads, lists metadata, and deletes provider credentials', async () => {
    const { store } = await harness()
    expect(await store.read('openai-codex')).toBeUndefined()

    const credential = oauth('secret-access', { accountId: 'account' })
    await store.modify('openai-codex', async () => credential)

    expect(await store.read('openai-codex')).toEqual(credential)
    const listed = await store.list()
    expect(listed).toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
    expect(JSON.stringify(listed)).not.toContain('secret-access')
    expect(JSON.stringify(listed)).not.toContain('refresh-secret-access')

    await store.delete('openai-codex')
    expect(await store.read('openai-codex')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('treats an undefined modify result as an unchanged credential', async () => {
    const { store } = await harness()
    const original = oauth('original', { accountId: 'retained' })
    await store.modify('openai-codex', async () => original)

    const result = await store.modify('openai-codex', async (current) => {
      expect(current).toEqual(original)
      return undefined
    })

    expect(result).toEqual(original)
    expect(await store.read('openai-codex')).toEqual(original)
  })

  it('keeps the old credential when the modify callback rejects', async () => {
    const { store } = await harness()
    const original = oauth('original')
    await store.modify('anthropic', async () => original)

    await expect(store.modify('anthropic', async () => {
      throw new Error('refresh failed')
    })).rejects.toThrow('refresh failed')

    expect(await store.read('anthropic')).toEqual(original)
  })

  it('serializes callbacks for the same provider', async () => {
    const { store } = await harness()
    let releaseFirst: (() => void) | undefined
    let secondEntered = false
    const firstCredential = oauth('first')
    const secondCredential = oauth('second')
    const firstEntered = new Promise<void>((resolve) => {
      void store.modify('openai-codex', async () => {
        resolve()
        await new Promise<void>((release) => { releaseFirst = release })
        return firstCredential
      })
    })
    await firstEntered

    const second = store.modify('openai-codex', async (current) => {
      secondEntered = true
      expect(current).toEqual(firstCredential)
      return secondCredential
    })
    await Promise.resolve()
    expect(secondEntered).toBe(false)
    releaseFirst?.()
    await second
    expect(await store.read('openai-codex')).toEqual(secondCredential)
  })

  it('serializes the same provider across store instances through the file lock', async () => {
    const { store } = await harness()
    const peer = new PiAiOAuthCredentialStore(store.directory)
    let releaseFirst: (() => void) | undefined
    let peerEntered = false
    const firstCredential = oauth('first-process')
    const firstEntered = new Promise<void>((resolve) => {
      void store.modify('openai-codex', async () => {
        resolve()
        await new Promise<void>((release) => { releaseFirst = release })
        return firstCredential
      })
    })
    await firstEntered

    const peerWrite = peer.modify('openai-codex', async (current) => {
      peerEntered = true
      expect(current).toEqual(firstCredential)
      return oauth('peer-process')
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(peerEntered).toBe(false)
    releaseFirst?.()
    await peerWrite
  })

  it('allows different providers to enter their callbacks in parallel', async () => {
    const { store } = await harness()
    const entered = new Set<string>()
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const operation = (provider: string) => store.modify(provider, async () => {
      entered.add(provider)
      if (entered.size === 2) release?.()
      await barrier
      return oauth(provider)
    })

    await Promise.all([operation('openai-codex'), operation('anthropic')])
    expect(entered).toEqual(new Set(['openai-codex', 'anthropic']))
    expect(await store.list()).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai-codex', type: 'oauth' },
    ])
  })

  it.runIf(process.platform !== 'win32')('creates owner-only directories and files', async () => {
    const { store } = await harness()
    await store.modify('openai-codex', async () => oauth('secret'))
    const [filename] = await readdir(store.directory)
    expect(filename).toBeDefined()

    const directoryMode = await stat(store.directory)
    const fileMode = await stat(join(store.directory, filename!))
    expect(directoryMode.mode & 0o777).toBe(0o700)
    expect(fileMode.mode & 0o777).toBe(0o600)
  })

  it.runIf(process.platform !== 'win32')('refuses broadened file and directory permissions', async () => {
    const { store } = await harness()
    await store.modify('openai-codex', async () => oauth('secret'))
    const [filename] = await readdir(store.directory)
    await chmod(join(store.directory, filename!), 0o644)
    await expect(store.read('openai-codex')).rejects.toThrow('permissions must be owner-only')

    await chmod(join(store.directory, filename!), 0o600)
    await chmod(store.directory, 0o755)
    await expect(store.list()).rejects.toThrow('permissions must be owner-only')
  })

  it('rejects malformed durable records without exposing their text', async () => {
    const { store } = await harness()
    await store.modify('openai-codex', async () => oauth('secret'))
    const [filename] = await readdir(store.directory)
    const path = join(store.directory, filename!)
    await writeFile(path, '{"access":"sentinel-secret"', { mode: 0o600 })

    const failure = await store.read('openai-codex').then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toBe('llm-pi-ai OAuth store: credential record is not valid JSON')
    expect(failure?.message).not.toContain('sentinel-secret')
  })

  it('rejects a record whose provider identity does not match its hashed filename', async () => {
    const { store } = await harness()
    await store.modify('openai-codex', async () => oauth('secret'))
    const [filename] = await readdir(store.directory)
    const path = join(store.directory, filename!)
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    record.providerId = 'anthropic'
    await writeFile(path, JSON.stringify(record), { mode: 0o600 })

    await expect(store.read('openai-codex')).rejects.toThrow('provider id does not match')
  })
})

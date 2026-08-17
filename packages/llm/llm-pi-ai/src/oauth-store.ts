/**
 * Persistent pi-ai OAuth credentials owned by the Harness home.
 *
 * Each provider has one canonical versioned file plus a legacy mirror during
 * mixed-version operation. Provider ids are hashed for filenames and retained
 * inside the record for collision and corruption checks.
 *
 * @module dsh-llm-pi-ai/oauth-store
 */

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const RECORD_VERSION = 1
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const RECORD_FILENAME = /^[0-9a-f]{64}\.json$/
const LEGACY_RECORD_FILENAME = /^[0-9a-f]{64}$/
const COMPATIBILITY_MARKER_SUFFIX = '.compat'

interface CredentialRecord {
  version: typeof RECORD_VERSION
  providerId: string
  credential: Credential
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether a value is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Validate provider ids before they cross the durable filename boundary. */
function assertProviderId(providerId: string): void {
  if (providerId.length === 0) throw new Error('llm-pi-ai OAuth store: provider id must be non-empty')
  if (providerId.includes('\0')) throw new Error('llm-pi-ai OAuth store: provider id contains a null byte')
}

/** Validate a JSON-compatible extension value without exposing its content. */
function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('llm-pi-ai OAuth store: ' + label + ' contains a non-finite number')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertJsonValue(entry, `${label}[${index}]`) })
    return
  }
  if (!isObject(value)) throw new Error('llm-pi-ai OAuth store: ' + label + ' is not JSON-compatible')
  for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, label + '.' + key)
}

/** Validate one credential at a durable or callback boundary. */
function assertCredential(value: unknown): asserts value is Credential {
  if (!isObject(value)) throw new Error('llm-pi-ai OAuth store: credential must be an object')
  if (value.type === 'api_key') {
    const allowed = new Set(['type', 'key', 'env'])
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error('llm-pi-ai OAuth store: api-key credential has an unknown field')
    }
    if (value.key !== undefined && (typeof value.key !== 'string' || value.key.length === 0)) {
      throw new Error('llm-pi-ai OAuth store: api-key credential key must be a non-empty string')
    }
    if (value.env !== undefined) {
      if (!isObject(value.env)) throw new Error('llm-pi-ai OAuth store: api-key credential env must be an object')
      for (const entry of Object.values(value.env)) {
        if (typeof entry !== 'string') throw new Error('llm-pi-ai OAuth store: api-key credential env values must be strings')
      }
    }
    return
  }
  if (value.type !== 'oauth') throw new Error('llm-pi-ai OAuth store: credential type is unsupported')
  if (typeof value.access !== 'string' || value.access.length === 0) {
    throw new Error('llm-pi-ai OAuth store: OAuth access token must be a non-empty string')
  }
  if (typeof value.refresh !== 'string' || value.refresh.length === 0) {
    throw new Error('llm-pi-ai OAuth store: OAuth refresh token must be a non-empty string')
  }
  if (typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires < 0) {
    throw new Error('llm-pi-ai OAuth store: OAuth expiry must be a non-negative finite number')
  }
  assertJsonValue(value, 'OAuth credential')
}

/** Parse and validate one provider record without returning secret-bearing diagnostics. */
function parseRecord(text: string, expectedProviderId?: string): CredentialRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('llm-pi-ai OAuth store: credential record is not valid JSON')
  }
  if (!isObject(value)) throw new Error('llm-pi-ai OAuth store: credential record must be an object')
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys[0] !== 'credential' || keys[1] !== 'providerId' || keys[2] !== 'version') {
    throw new Error('llm-pi-ai OAuth store: credential record fields are invalid')
  }
  if (value.version !== RECORD_VERSION) throw new Error('llm-pi-ai OAuth store: credential record version is unsupported')
  if (typeof value.providerId !== 'string') throw new Error('llm-pi-ai OAuth store: credential record provider id is invalid')
  assertProviderId(value.providerId)
  if (expectedProviderId !== undefined && value.providerId !== expectedProviderId) {
    throw new Error('llm-pi-ai OAuth store: credential record provider id does not match its filename')
  }
  assertCredential(value.credential)
  return { version: RECORD_VERSION, providerId: value.providerId, credential: value.credential }
}

/** Render one validated provider record. */
function renderRecord(providerId: string, credential: Credential): string {
  assertProviderId(providerId)
  assertCredential(credential)
  return JSON.stringify({ version: RECORD_VERSION, providerId, credential } satisfies CredentialRecord, null, 2) + '\n'
}

/** Reject symlinks, unexpected file kinds, and non-owner permission bits. */
async function assertPrivatePath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const stats = await lstat(path)
  const expectedKind = kind === 'directory' ? stats.isDirectory() : stats.isFile()
  if (stats.isSymbolicLink() || !expectedKind) {
    throw new Error('llm-pi-ai OAuth store: credential ' + kind + ' has an unsafe file type')
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error('llm-pi-ai OAuth store: credential ' + kind + ' permissions must be owner-only')
  }
}

/** Read and stat the same owner-only inode, without following a final symlink. */
async function readPrivateFile(filename: string): Promise<{ text: string; modifiedAt: number } | undefined> {
  let handle
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    handle = await open(filename, fsConstants.O_RDONLY | noFollow)
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('llm-pi-ai OAuth store: credential file has an unsafe file type')
    }
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new Error('llm-pi-ai OAuth store: credential file permissions must be owner-only')
    }
    return { text: await handle.readFile('utf8'), modifiedAt: stats.mtimeMs }
  } finally {
    await handle.close()
  }
}

async function privatePathExists(path: string, kind: 'directory' | 'file'): Promise<boolean> {
  try {
    await assertPrivatePath(path, kind)
    return true
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

/**
 * Persistent provider-scoped credential store for pi-ai.
 *
 * modify and delete serialize in-process and through both generation lock paths
 * in a fixed order so old and new writers cannot overlap. A persistent marker
 * makes partial writes and deletes fail closed. Readers bind metadata and bytes
 * to one opened inode while complete files commit by same-directory rename.
 * The shared atomic writer does not fsync; a sudden
 * power loss may lose the latest completed replacement while never exposing a
 * partially written JSON document.
 */
export class PiAiOAuthCredentialStore implements CredentialStore {
  private readonly operations = new Map<string, Promise<void>>()

  /** @param directory - credential record directory; defaults inside the Harness home. */
  constructor(readonly directory = dshHomePath('credentials', 'pi-ai-v1')) {}

  private filename(providerId: string): string {
    assertProviderId(providerId)
    const digest = createHash('sha256').update(providerId).digest('hex')
    return join(this.directory, digest + '.json')
  }

  private legacyFilename(providerId: string): string {
    return this.filename(providerId).slice(0, -'.json'.length)
  }

  private compatibilityFilename(providerId: string): string {
    return this.legacyFilename(providerId) + COMPATIBILITY_MARKER_SUFFIX
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    await assertPrivatePath(this.directory, 'directory')
  }

  private async readRecord(providerId: string): Promise<CredentialRecord | undefined> {
    const canonicalFilename = this.filename(providerId)
    const legacyFilename = this.legacyFilename(providerId)
    const compatibilityManaged = await privatePathExists(this.compatibilityFilename(providerId), 'file')
    const records: { record: CredentialRecord; modifiedAt: number; canonical: boolean }[] = []
    for (const [filename, canonical] of [
      [canonicalFilename, true],
      [legacyFilename, false],
    ] as const) {
      const opened = await readPrivateFile(filename)
      if (opened === undefined) continue
      records.push({
        record: parseRecord(opened.text, providerId),
        modifiedAt: opened.modifiedAt,
        canonical,
      })
    }
    if (compatibilityManaged && records.length !== 2) return undefined
    records.sort((left, right) => right.modifiedAt - left.modifiedAt
      || Number(left.canonical) - Number(right.canonical))
    return records[0]?.record
  }

  private enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(providerId) ?? Promise.resolve()
    const task = previous.then(operation)
    const settled = task.then(() => undefined, () => undefined)
    this.operations.set(providerId, settled)
    void settled.finally(() => {
      if (this.operations.get(providerId) === settled) this.operations.delete(providerId)
    })
    return task
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readRecord(providerId))?.credential
  }

  async list(): Promise<readonly CredentialInfo[]> {
    let entries
    try {
      await assertPrivatePath(this.directory, 'directory')
      entries = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
    const entryNames = new Set(entries.map(entry => entry.name))
    const records = new Map<string, { info: CredentialInfo; canonical: boolean }>()
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!RECORD_FILENAME.test(entry.name) && !LEGACY_RECORD_FILENAME.test(entry.name)) continue
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('llm-pi-ai OAuth store: credential directory contains an unsafe entry')
      }
      const filename = join(this.directory, entry.name)
      const opened = await readPrivateFile(filename)
      if (opened === undefined) continue
      const record = parseRecord(opened.text)
      if (this.filename(record.providerId) !== filename && this.legacyFilename(record.providerId) !== filename) {
        throw new Error('llm-pi-ai OAuth store: credential record filename is invalid')
      }
      const canonical = RECORD_FILENAME.test(entry.name)
      const digest = canonical ? entry.name.slice(0, -'.json'.length) : entry.name
      const compatibilityName = digest + COMPATIBILITY_MARKER_SUFFIX
      if (entryNames.has(compatibilityName)
        && (!entryNames.has(digest) || !entryNames.has(digest + '.json'))) {
        await assertPrivatePath(join(this.directory, compatibilityName), 'file')
        continue
      }
      const existing = records.get(record.providerId)
      if (existing === undefined || (!existing.canonical && canonical)) {
        records.set(record.providerId, {
          info: { providerId: record.providerId, type: record.credential.type },
          canonical,
        })
      }
    }
    return [...records.values()].map(record => record.info)
      .sort((left, right) => left.providerId.localeCompare(right.providerId))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    assertProviderId(providerId)
    return this.enqueue(providerId, async () => {
      await this.ensureDirectory()
      const filename = this.filename(providerId)
      const legacyFilename = this.legacyFilename(providerId)
      return withFileLock(legacyFilename, () => withFileLock(filename, async () => {
        const current = (await this.readRecord(providerId))?.credential
        const candidate = await fn(current)
        if (candidate === undefined) return current
        assertCredential(candidate)
        const rendered = renderRecord(providerId, candidate)
        await writeFileAtomic(this.compatibilityFilename(providerId), 'compat-v1\n', {
          mode: PRIVATE_FILE_MODE,
          dirMode: PRIVATE_DIRECTORY_MODE,
        })
        await writeFileAtomic(filename, rendered, {
          mode: PRIVATE_FILE_MODE,
          dirMode: PRIVATE_DIRECTORY_MODE,
        })
        await writeFileAtomic(legacyFilename, rendered, {
          mode: PRIVATE_FILE_MODE,
          dirMode: PRIVATE_DIRECTORY_MODE,
        })
        return candidate
      }))
    })
  }

  async delete(providerId: string): Promise<void> {
    assertProviderId(providerId)
    await this.enqueue(providerId, async () => {
      await this.ensureDirectory()
      const filename = this.filename(providerId)
      const legacyFilename = this.legacyFilename(providerId)
      await withFileLock(legacyFilename, () => withFileLock(filename, async () => {
        await rm(filename, { force: true })
        await rm(legacyFilename, { force: true })
      }))
    })
  }
}

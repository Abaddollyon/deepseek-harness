/** In-memory credential seam shared by integration fixtures; no reference credentials are available. */
import type { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Records a second Host mount may share with the first, to model a restart over the same store. */
interface MemoryCredentialsConfig {
  records?: Map<CredentialKey, CredentialRecord>
}

export class MemoryCredentials extends CredentialProvider {
  readonly records: Map<CredentialKey, CredentialRecord>

  constructor(ctx: Context, config?: MemoryCredentialsConfig) {
    super(ctx)
    const records: Map<CredentialKey, CredentialRecord> | undefined = config?.records
    this.records = records ?? new Map<CredentialKey, CredentialRecord>()
  }

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    throw new Error('credential references are unused in this suite')
  }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    throw new Error('credential references are unused in this suite')
  }

  set(_ref: CredentialRef, _value: string): Promise<void> {
    throw new Error('credential references are unused in this suite')
  }

  unset(_ref: CredentialRef): Promise<void> {
    throw new Error('credential references are unused in this suite')
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = this.records.get(key)
    return Promise.resolve(stored === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: stored.kind, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(key, next)
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

export default MemoryCredentials

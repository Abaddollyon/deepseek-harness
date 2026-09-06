/**
 * Real-composition tests for the Host connection owner and the agent-side
 * host-connection transport: real settings/credentials/authorization seams,
 * a real Streamable HTTP MCP fixture, and fake protocol engines whose
 * authenticated fetch maps the configured HTTPS endpoint onto the local
 * fixture. No SDK mocks: the whole path from settings through the supervisor
 * to tool registration runs. A second suite runs the REAL protocol engine
 * (SDK auth, PKCE, refresh) over an in-memory authorization server with the
 * credential store's actual record-updated events.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { NativeMcpConnectionsService, SETTINGS_NS, createOAuthEngine } from '@deepseek-ai/dsh-mcp-client/src/connections.ts'
import type {
  McpConnectionEngine, McpConnectionEngineFactory, McpConnectionEngineInit,
  McpConnectionEngineStatus, McpConnectionEntry,
} from '@deepseek-ai/dsh-mcp-client/src/connections.ts'
import type { McpOAuthChangeEvent, McpOAuthRevocation } from '@deepseek-ai/dsh-mcp-client/src/connections.ts'
import { startHttpMcpFixture } from './http-fixture.ts'
import type { HttpMcpFixture } from './http-fixture.ts'
import { Fixture as AuthorizationServerFixture } from './oauth-fixture.ts'
import type { FixtureOptions } from './oauth-fixture.ts'

// ---- Minimal in-memory seam providers (record half and document only) ----

/** Records a second Host mount may share with the first, to model a restart over the same store. */
interface MemoryCredentialsConfig {
  records?: Map<CredentialKey, CredentialRecord>
}

class MemoryCredentials extends CredentialProvider {
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

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, config?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(config?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: never, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

// ---- Fake protocol engine ----

/** The configured HTTPS endpoint the engines map onto the local fixture. */
const CONFIGURED_URL = 'https://fixture.mcp.test/mcp'
const ISSUER_URL = 'https://issuer.mcp.test'

function connectionEntry(overrides: Partial<McpConnectionEntry> = {}): Record<string, unknown> {
  return {
    url: CONFIGURED_URL,
    issuerUrl: ISSUER_URL,
    redirectUri: 'https://client.mcp.test/callback',
    scopes: ['mcp'],
    ...overrides,
  }
}

class FakeEngine implements McpConnectionEngine {
  state: McpConnectionEngineStatus['state'] = 'authorized'
  disposed = false
  /** Test-controlled gate authorize() waits on before committing. */
  authorizeGate: PromiseWithResolvers<void> | undefined
  /** Make status() reject, as an engine over an unreadable store would. */
  failStatus = false
  /** Make dispose() reject. */
  failDispose = false
  private epoch = 0
  private readonly written = new Set<string>()

  constructor(
    readonly init: McpConnectionEngineInit,
    private readonly upstream: string,
  ) {}

  status(): Promise<McpConnectionEngineStatus> {
    if (this.failStatus) return Promise.reject(new Error('status unavailable'))
    return Promise.resolve({
      state: this.state,
      inFlight: this.authorizeGate === undefined ? undefined : 'authorize',
      hasRefreshToken: true,
      accessTokenExpiresAt: undefined,
      grantedScope: 'mcp',
      epoch: this.epoch,
    })
  }

  /** Commit through the seam the way the real engine does: the store emits record-updated for it. */
  private async commit(payload: Record<string, unknown>): Promise<number> {
    const epoch = ++this.epoch
    const stored = { ...payload, epoch }
    this.written.add(JSON.stringify(stored))
    await this.init.ctx.credentials.modifyRecord(this.init.credentialKey, () =>
      Promise.resolve({ kind: 'grant', payload: stored }))
    return epoch
  }

  async authorize(_session: AuthorizationSession): Promise<void> {
    const gate = this.authorizeGate
    if (gate !== undefined) await gate.promise
    // The seam confirms this exact record write before reporting authorized.
    const epoch = await this.commit({ fake: 'grant' })
    this.state = 'authorized'
    this.authorizeGate = undefined
    this.init.onChange({ kind: 'authorized', epoch, grantedScope: 'mcp' })
  }

  authenticatedFetch(signal: AbortSignal): FetchLike {
    const upstream = this.upstream
    const state = (): McpConnectionEngineStatus['state'] => this.state
    return async (input, init) => {
      if (state() !== 'authorized') throw new Error('AUTH_REQUIRED')
      const target = String(input).replace('https://fixture.mcp.test', upstream)
      const headers = new Headers(init?.headers)
      headers.set('authorization', 'Bearer fake-token')
      return fetch(target, { ...init, headers, signal })
    }
  }

  captureOwnership(): (record: CredentialRecord | undefined) => boolean {
    const written = new Set(this.written)
    return record => record?.kind === 'grant' && written.has(JSON.stringify(record.payload))
  }

  async revoke(): Promise<McpOAuthRevocation> {
    this.state = 'revoked'
    const epoch = await this.commit({ revoked: true })
    this.init.onChange({ kind: 'revoked', epoch, grantedScope: undefined })
    return { local: 'revoked', remote: 'unsupported' }
  }

  /** Report that the server rejected the grant, as the real engine does after a final 401 or invalid_grant. */
  invalidateGrant(): void {
    this.state = 'auth-required'
    this.init.onChange({ kind: 'invalidated', epoch: ++this.epoch, grantedScope: undefined })
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.state = 'disposed'
    this.init.onChange({ kind: 'disposed', epoch: undefined, grantedScope: undefined })
    return this.failDispose ? Promise.reject(new Error('dispose failed')) : Promise.resolve()
  }
}

// ---- Harness ----

const testToolSignal = new AbortController().signal

interface Harness {
  ctx: Context
  service: NativeMcpConnectionsService
  credentials: MemoryCredentials
  engines: FakeEngine[]
  fixture: HttpMcpFixture
}

function hostConfig(overrides: Record<string, unknown> = {}): Config {
  const config: Record<string, unknown> = {
    transport: 'host-connection',
    serverName: 'srv',
    connectionId: 'github',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...overrides,
  }
  return config as unknown as Config
}

async function mountHarness(options: {
  doc?: Record<string, unknown>
  engineFactory?: McpConnectionEngineFactory
} = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fixture = await startHttpMcpFixture()
  const engines: FakeEngine[] = []
  const factory: McpConnectionEngineFactory = options.engineFactory ?? ((init) => {
    const engine = new FakeEngine(init, fixture.url)
    engines.push(engine)
    return engine
  })
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(MemorySettings, { doc: options.doc ?? { [SETTINGS_NS]: { github: connectionEntry() } } })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(NativeMcpConnectionsService, { engineFactory: factory })
  const service = ctx.get('nativeMcpConnections') as NativeMcpConnectionsService
  const credentials = ctx.get('credentials') as MemoryCredentials
  return { ctx, service, credentials, engines, fixture }
}

function silentInteraction(): AuthorizationInteraction {
  return {
    notify: () => {},
    prompt: () => Promise.resolve('https://client.mcp.test/callback?code=fake&state=fake'),
  }
}

async function epochOf(harness: { service: NativeMcpConnectionsService }, id = 'github'): Promise<number> {
  const view = await harness.service.describe(id)
  if (view === undefined) throw new Error(`connection "${id}" is unknown`)
  return view.epoch
}

describe('nativeMcpConnections host service', () => {
  let harness: Harness | undefined

  beforeEach(() => {
    harness = undefined
  })

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.ctx.fiber.dispose()
      await harness.fixture.close()
    }
  })

  it('reconciles the stored document into an engine, a flow, and token-free status facts', async () => {
    harness = await mountHarness()

    const view = await harness.service.describe('github')
    expect(view).toMatchObject({
      id: 'github',
      url: CONFIGURED_URL,
      configured: true,
      state: 'authorized',
      inFlightAuth: false,
      consumers: [],
    })
    expect(JSON.stringify(view)).not.toContain('fake-token')

    const flows = harness.ctx.authorization.list()
    expect(flows).toHaveLength(1)
    expect(flows[0]!.key).toBe(harness.service.recordKeyFor('github'))
    expect(flows[0]!.methods[0]!.id).toBe('oauth')
  })

  it('refuses an unserviceable section at the settings write', async () => {
    harness = await mountHarness()

    await expect(harness.ctx.settings.update(SETTINGS_NS, {
      broken: connectionEntry({ url: 'http://fixture.mcp.test/mcp' }),
    })).rejects.toThrow(/HTTPS/)
    await expect(harness.ctx.settings.update(SETTINGS_NS, {
      'Bad Id': connectionEntry(),
    })).rejects.toThrow(/must match/)
    await expect(harness.ctx.settings.update(SETTINGS_NS, {
      broken: connectionEntry({ url: 'https://user:pw@fixture.mcp.test/mcp' }),
    })).rejects.toThrow(/userinfo/)
    // The refused writes changed nothing.
    expect(await harness.service.describe('broken')).toBeUndefined()
  })

  it('connects an agent through the host-built transport and registers real tools', async () => {
    harness = await mountHarness()

    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    // Every fixture request carried the engine-attached bearer, never a caller header.
    expect(harness.fixture.authorization.length).toBeGreaterThan(0)
    expect(new Set(harness.fixture.authorization)).toEqual(new Set(['Bearer fake-token']))

    const result = await harness.ctx.tools.execute({
      signal: testToolSignal,
      callId: 'call-1' as never,
      name: 'mcp__srv__ping',
      arguments: {},
    })
    expect(result.isError).toBe(false)

    const view = await harness.service.describe('github')
    expect(view?.consumers).toEqual(['srv'])
  })

  it('fails plugin load loudly when the owner is not mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(apply(ctx, hostConfig())).rejects.toThrow(/requires the nativeMcpConnections Host service/)
    await ctx.fiber.dispose()
  })

  it('fails plugin load loudly for an unknown connectionId', async () => {
    harness = await mountHarness()
    await expect(apply(harness.ctx, hostConfig({ connectionId: 'gitlab' })))
      .rejects.toThrow(/unknown connection "gitlab"/)
  })

  it('rejects url/header overrides and a connectionId on a legacy transport', async () => {
    harness = await mountHarness()
    await expect(apply(harness.ctx, hostConfig({ url: 'https://evil.example/mcp' })))
      .rejects.toThrow(/owns url and headers/)
    await expect(apply(harness.ctx, hostConfig({ headers: { authorization: 'Bearer x' } })))
      .rejects.toThrow(/owns url and headers/)
    await expect(apply(harness.ctx, {
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'https://fixture.mcp.test/mcp',
      connectionId: 'github',
    } as never)).rejects.toThrow(/requires transport "host-connection"/)
  })

  it('revocation withdraws the tools and holds until the human re-authorizes', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    const outcome = await harness.service.revoke('github')
    expect(outcome).toEqual({ local: 'revoked', remote: 'unsupported' })
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect((await harness.service.describe('github'))?.state).toBe('revoked')

    // The revoked connection cannot resurrect: once the bounces settled, no
    // new fixture traffic appears. (Requests legitimately in flight at
    // revocation land during the settle window, so the snapshot waits for it.)
    await new Promise(resolve => setTimeout(resolve, 80))
    const requests = harness.fixture.authorization.length
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(harness.fixture.authorization.length).toBe(requests)

    // Re-authorization through the real seam: the flow runs, commits, and the
    // settled attempt re-establishes the consumer.
    harness.engines[0]!.state = 'auth-required'
    harness.engines[0]!.authorizeGate = Promise.withResolvers()
    const attempt = harness.ctx.authorization.begin({
      key: harness.service.recordKeyFor('github'),
      interaction: silentInteraction(),
    })
    await vi.waitFor(async () => {
      expect((await harness!.service.describe('github'))?.inFlightAuth).toBe(true)
    })
    harness.engines[0]!.authorizeGate.resolve()
    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
  })

  it('a settings scope change swaps the engine without reporting the retired engine as removed', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    expect(harness.engines).toHaveLength(1)
    const reasons: string[] = []
    const binding = harness.service.acquire('github', { serverName: 'observer' })
    binding.onInvalidate((reason) => { reasons.push(reason) })

    await harness.ctx.settings.update(SETTINGS_NS, { github: { scopes: ['mcp', 'admin'] } })

    await vi.waitFor(() => { expect(harness!.engines).toHaveLength(2) })
    // The old engine is quiesced before the new one serves, and its own
    // disposed transition (fired from dispose()) never reached consumers.
    expect(harness.engines[0]!.disposed).toBe(true)
    expect(harness.engines[1]!.init.spec.scopes).toEqual(['mcp', 'admin'])
    expect(reasons).toEqual(['config-changed', 'config-changed'])
    // The consumer was invalidated and re-established against the new spec.
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    binding.release()
  })

  it('removing the configuration withdraws tools and the flow but keeps bound consumers reachable for a re-add', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    await harness.ctx.settings.replace(SETTINGS_NS, {})

    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect(await harness.service.describe('github')).toMatchObject({ configured: false, state: 'unavailable', consumers: ['srv'] })
    expect((await harness.service.list()).map(view => view.id)).toEqual(['github'])
    expect(harness.ctx.authorization.list()).toHaveLength(0)
    expect(harness.engines[0]!.disposed).toBe(true)
    expect(() => harness!.service.acquire('github', { serverName: 'late' })).toThrow(/unknown connection/)
    await expect(harness.service.revoke('github')).rejects.toThrow(/unknown connection/)

    // Re-adding the same id reaches the consumer that kept its binding: no orphaned state.
    await harness.ctx.settings.replace(SETTINGS_NS, { github: connectionEntry() })
    await vi.waitFor(() => { expect(harness!.engines).toHaveLength(2) })
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    expect(await harness.service.describe('github')).toMatchObject({ configured: true, state: 'authorized', consumers: ['srv'] })

    // A removed connection nobody binds is forgotten outright.
    await harness.ctx.settings.replace(SETTINGS_NS, {})
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    const [orphan] = await harness.service.list()
    expect(orphan?.configured).toBe(false)
  })

  it('an external grant deletion invalidates consumers through the record event', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    // Seed the grant an earlier authorization would have committed; deleting
    // an absent record emits nothing by design.
    await harness.credentials.modifyRecord(harness.service.recordKeyFor('github'), () =>
      Promise.resolve({ kind: 'grant', payload: { fake: 'grant' } }))
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    harness.engines[0]!.state = 'auth-required'
    await harness.service.removeGrant('github')

    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect(harness.credentials.records.has(harness.service.recordKeyFor('github'))).toBe(false)
  })

  it('an engine the factory cannot construct reports unavailable with a safe log token', async () => {
    const errors: string[] = []
    harness = await mountHarness({
      engineFactory: () => { throw new Error('secret-payload-message') },
    })
    harness.ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof harness.ctx.logger.error

    // Reconcile happens at mount; mount again through a fresh harness for the log line.
    await harness.ctx.fiber.dispose()
    await harness.fixture.close()
    harness = await mountHarness({
      engineFactory: () => { throw new Error('secret-payload-message') },
    })
    harness.ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof harness.ctx.logger.error
    await harness.ctx.settings.update(SETTINGS_NS, { second: connectionEntry() })

    const view = await harness.service.describe('github')
    expect(view?.state).toBe('unavailable')
    expect(harness.ctx.authorization.list()).toHaveLength(0)
    // A binding still resolves, but no transport exists while no engine does.
    const binding = harness.service.acquire('github', { serverName: 'srv' })
    await expect(binding.connect(new AbortController().signal)).resolves.toBeUndefined()
    binding.release()
  })

  it('disposes an engine whose authorization flow cannot register and reports the connection unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fixture = await startHttpMcpFixture()
    const engines: FakeEngine[] = []
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings, { doc: { [SETTINGS_NS]: { github: connectionEntry() } } })
    await ctx.plugin(AuthorizationService)
    // Another plugin already claims the flow key the connection would register.
    const release = ctx.authorization.registerFlow({
      key: 'mcp-connections/github' as CredentialKey,
      label: 'squatter',
      methods: [{ id: 'other', label: 'Other' }],
      run: () => Promise.resolve(),
    })
    const errors: string[] = []
    await ctx.plugin(NativeMcpConnectionsService, {
      engineFactory: (init: McpConnectionEngineInit) => {
        const engine = new FakeEngine(init, fixture.url)
        engine.failDispose = engines.length === 0
        engines.push(engine)
        return engine
      },
    })
    const service = ctx.get('nativeMcpConnections') as NativeMcpConnectionsService
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    await ctx.settings.update(SETTINGS_NS, { github: connectionEntry({ label: 'renamed' }) })
    await expect(service.revoke('github')).rejects.toThrow(/no live protocol engine/)

    expect(engines).toHaveLength(2)
    expect(engines.every(engine => engine.disposed)).toBe(true)
    expect(errors.some(line => line.includes('cannot register its authorization flow'))).toBe(true)
    expect((await service.describe('github'))?.state).toBe('unavailable')
    release()
    await ctx.fiber.dispose()
    await fixture.close()
  })

  it('refuses to mount under an agent scope and a second time in one Host', async () => {
    harness = await mountHarness()
    await expect(harness.ctx.plugin(NativeMcpConnectionsService)).rejects.toThrow(/has been registered/)

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings, { doc: {} })
    await ctx.plugin(AuthorizationService)
    const agent = createScope(ctx, {})
    await expect(agent.ctx.plugin(NativeMcpConnectionsService)).rejects.toThrow(/Host singleton/)
    await agent.dispose()
    await ctx.fiber.dispose()
  })

  it('validates every URL field and the id grammar of record keys', async () => {
    harness = await mountHarness()
    await expect(harness.ctx.settings.update(SETTINGS_NS, { broken: connectionEntry({ url: 'not a url' }) }))
      .rejects.toThrow(/absolute URL/)
    await expect(harness.ctx.settings.update(SETTINGS_NS, { broken: connectionEntry({ resourceUrl: 'http://fixture.mcp.test/' }) }))
      .rejects.toThrow(/resourceUrl must be an HTTPS URL/)
    expect(() => harness!.service.recordKeyFor('Bad Id')).toThrow(/must match/)
    // The id cap matches the agent-side connectionId schema: 64 characters, not 65.
    const longest = `a${'b'.repeat(63)}`
    await harness.ctx.settings.update(SETTINGS_NS, { [longest]: connectionEntry() })
    expect(await harness.service.describe(longest)).toMatchObject({ configured: true })
    await expect(harness.ctx.settings.update(SETTINGS_NS, { [`${longest}c`]: connectionEntry() })).rejects.toThrow(/must match/)
    expect(() => harness!.service.recordKeyFor(`${longest}c`)).toThrow(/must match/)
  })

  it('judges record events only for its own scope and known ids, and settlement events not at all', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const before = await epochOf(harness)
    harness.ctx.emit('credentials/record-updated', 'other-plugin/github' as CredentialKey)
    harness.ctx.emit('credentials/record-updated', 'mcp-connections/nobody' as CredentialKey)
    harness.ctx.emit('authorization/settled', harness.service.recordKeyFor('github'), 'authorized')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await epochOf(harness)).toBe(before)
    // An engine reporting its own disposal while still attached is not a consumer event either.
    harness.engines[0]!.init.onChange({ kind: 'disposed', epoch: undefined, grantedScope: undefined })
    expect(await epochOf(harness)).toBe(before)
  })

  it('withdraws consumers when the server invalidates the grant, and contains a throwing listener', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    const binding = harness.service.acquire('github', { serverName: 'observer' })
    expect(binding.epoch).toBe(await epochOf(harness))
    binding.onInvalidate(() => { throw new Error('listener broke') })
    const reasons: string[] = []
    binding.onInvalidate((reason) => { reasons.push(reason) })

    harness.engines[0]!.invalidateGrant()
    expect(reasons).toEqual(['invalid-grant'])
    expect(warnings.some(line => line.includes('invalidation listener'))).toBe(true)
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect(binding.epoch).toBe(await epochOf(harness))
    binding.release()
  })

  it('treats an external record write as a change of authority, but not one the engine made or one it can no longer judge', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const binding = harness.service.acquire('github', { serverName: 'observer' })
    const reasons: string[] = []
    binding.onInvalidate((reason) => { reasons.push(reason) })
    const key = harness.service.recordKeyFor('github')

    // The engine's own write: recognized, exactly one withdrawal for the new grant (no stale, no settled duplicate).
    await harness.ctx.authorization.begin({ key, interaction: silentInteraction() })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reasons).toEqual(['reauthorized'])

    // An external write: withdrawn as stale.
    await harness.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { foreign: true } }))
    await vi.waitFor(() => { expect(reasons).toEqual(['reauthorized', 'stale']) })

    // A write judged while the engine is being swapped: the swap's own invalidation stands alone.
    const gate = Promise.withResolvers<undefined>()
    const read = harness.credentials.readRecord.bind(harness.credentials)
    harness.credentials.readRecord = async (readKey) => { await gate.promise; return read(readKey) }
    await harness.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { foreign: 2 } }))
    await harness.ctx.settings.update(SETTINGS_NS, { github: { label: 'renamed' } })
    harness.credentials.readRecord = read
    gate.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reasons).toEqual(['reauthorized', 'stale', 'config-changed', 'config-changed'])

    // Barrier: an external write whose judgement read is slow, followed by the engine's own commit before
    // that read returns. The external change still withdraws — an own write after the event never hides it —
    // while the own commit is judged as own by its own event.
    const snapshot = Promise.withResolvers<undefined>()
    let held = false
    harness.credentials.readRecord = (readKey) => {
      const current = harness!.credentials.records.get(readKey)
      if (held) return read(readKey)
      held = true
      return snapshot.promise.then(() => current)
    }
    await harness.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { foreign: 4 } }))
    await harness.ctx.authorization.begin({ key, interaction: silentInteraction() })
    await vi.waitFor(() => { expect(reasons.at(-1)).toBe('reauthorized') })
    expect(reasons).toEqual(['reauthorized', 'stale', 'config-changed', 'config-changed', 'reauthorized'])
    snapshot.resolve(undefined)
    await vi.waitFor(() => { expect(reasons).toEqual(['reauthorized', 'stale', 'config-changed', 'config-changed', 'reauthorized', 'stale']) })
    harness.credentials.readRecord = read
    // The reverse order — the engine's own event judged while its read returns the record as it stood — is own.
    await harness.ctx.authorization.begin({ key, interaction: silentInteraction() })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reasons.at(-1)).toBe('reauthorized')
    expect(reasons.filter(reason => reason === 'stale')).toHaveLength(2)

    // An unreadable store: withdrawn rather than trusted.
    harness.credentials.readRecord = () => Promise.reject(new Error('store offline'))
    await harness.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { foreign: 3 } }))
    await vi.waitFor(() => { expect(reasons.at(-1)).toBe('stale') })
    harness.credentials.readRecord = read
    binding.release()
  })

  it('withdraws consumers on a record change while no engine can judge it, and tolerates a status read failure at equip', async () => {
    harness = await mountHarness({ engineFactory: () => { throw new Error('no engine') } })
    const binding = harness.service.acquire('github', { serverName: 'observer' })
    const reasons: string[] = []
    binding.onInvalidate((reason) => { reasons.push(reason) })
    harness.ctx.emit('credentials/record-updated', harness.service.recordKeyFor('github'))
    expect(reasons).toEqual(['stale'])
    binding.release()
    await harness.ctx.fiber.dispose()
    await harness.fixture.close()

    harness = await mountHarness({
      engineFactory: (init) => {
        const engine = new FakeEngine(init, 'http://127.0.0.1:1')
        engine.failStatus = true
        return engine
      },
    })
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    expect((await harness.service.describe('github'))?.state).toBe('unavailable')
    expect(warnings.some(line => line.includes('could not report its status'))).toBe(true)
    expect(await harness.service.list()).toHaveLength(1)
  })

  it('reports and enforces a refusal without waiting on an engine whose status never settles, and re-judges after the wait', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const engine = harness.engines[0]!
    const authorizedStatus: McpConnectionEngineStatus = {
      state: 'authorized', inFlight: undefined, hasRefreshToken: true, accessTokenExpiresAt: undefined, grantedScope: 'mcp', epoch: 1,
    }
    const status = engine.status.bind(engine)

    // A refusal that arrives while a status view is awaiting the engine: the view reports it.
    const describing = Promise.withResolvers<McpConnectionEngineStatus>()
    engine.status = () => describing.promise
    const view = harness.service.describe('github')
    engine.init.onChange({ kind: 'revoked', epoch: undefined, grantedScope: undefined })
    describing.resolve(authorizedStatus)
    expect((await view)?.state).toBe('revoked')
    engine.init.onChange({ kind: 'authorized', epoch: 2, grantedScope: 'mcp' })
    expect((await harness.service.describe('github'))?.state).toBe('authorized')

    // A refusal that arrives while a direct binding caller is awaiting the engine's status: no transport,
    // even though that caller never aborted its signal.
    const pending = Promise.withResolvers<McpConnectionEngineStatus>()
    engine.status = () => pending.promise
    const binding = harness.service.acquire('github', { serverName: 'direct' })
    const connecting = binding.connect(new AbortController().signal)
    engine.state = 'revoked'
    engine.init.onChange({ kind: 'revoked', epoch: undefined, grantedScope: undefined })
    pending.resolve(authorizedStatus)
    await expect(connecting).resolves.toBeUndefined()

    // While refused, status views never consult the engine — a hanging store cannot delay or hide the refusal.
    let asked = 0
    engine.status = () => { asked += 1; return new Promise(() => {}) }
    expect((await harness.service.describe('github'))?.state).toBe('revoked')
    expect((await harness.service.list())[0]?.state).toBe('revoked')
    await expect(binding.connect(new AbortController().signal)).resolves.toBeUndefined()
    expect(asked).toBe(0)
    engine.status = status
    binding.release()
  })

  it('service disposal quiesces engines and withdraws flows and consumers', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fixture = await startHttpMcpFixture()
    const engines: FakeEngine[] = []
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings, { doc: { [SETTINGS_NS]: { github: connectionEntry() } } })
    await ctx.plugin(AuthorizationService)
    const fiber = ctx.plugin(NativeMcpConnectionsService, {
      engineFactory: (init: McpConnectionEngineInit) => {
        const engine = new FakeEngine(init, fixture.url)
        engines.push(engine)
        return engine
      },
    })
    // ctx.plugin returns before activation settles; apply reads the owner synchronously.
    await vi.waitFor(() => { expect(ctx.get('nativeMcpConnections')).toBeDefined() })
    await apply(ctx, hostConfig())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    await fiber.dispose()

    expect(engines[0]!.disposed).toBe(true)
    expect(ctx.authorization.list()).toHaveLength(0)
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    await ctx.fiber.dispose()
    await fixture.close()
  })
})

// ---- Real engine over a fake network ----

interface RealHarness {
  ctx: Context
  service: NativeMcpConnectionsService
  credentials: MemoryCredentials
  authorizationServer: AuthorizationServerFixture
  mcp: HttpMcpFixture
  clock: { now: number }
  events: McpOAuthChangeEvent[]
  dispose(): Promise<void>
}

/**
 * Mount the Host owner with the REAL protocol engine. OAuth traffic goes to
 * the in-memory authorization server; MCP traffic is forwarded to the local
 * Streamable HTTP fixture once the bearer token checks out.
 */
async function mountRealHarness(options: {
  scopes?: string[]
  serverOptions?: FixtureOptions
  records?: Map<CredentialKey, CredentialRecord>
  authorizationServer?: AuthorizationServerFixture
  /** An MCP fixture inherited from an earlier Host mount; this harness takes over closing it. */
  mcp?: HttpMcpFixture
} = {}): Promise<RealHarness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const mcp = options.mcp ?? await startHttpMcpFixture()
  const authorizationServer = options.authorizationServer
    ?? new AuthorizationServerFixture({ scopeInResponse: (options.scopes ?? ['mcp']).join(' '), ...options.serverOptions }, { server: CONFIGURED_URL, issuer: ISSUER_URL })
  authorizationServer.mcp = request => fetch(request.url.replace('https://fixture.mcp.test', mcp.url), {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(request.body === null ? {} : { body: request.body, duplex: 'half' } as RequestInit),
  })
  const clock = { now: 1_700_000_000_000 }
  const events: McpOAuthChangeEvent[] = []
  await ctx.plugin(MemoryCredentials, options.records === undefined ? {} : { records: options.records })
  await ctx.plugin(MemorySettings, { doc: { [SETTINGS_NS]: { github: connectionEntry({ scopes: options.scopes ?? ['mcp'] }) } } })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(NativeMcpConnectionsService, {
    engineFactory: (init: McpConnectionEngineInit) => createOAuthEngine({
      ...init,
      onChange: (event) => { events.push(event); init.onChange(event) },
    }, { fetch: authorizationServer.fetch, now: () => clock.now }),
  })
  const service = ctx.get('nativeMcpConnections') as NativeMcpConnectionsService
  const credentials = ctx.get('credentials') as MemoryCredentials
  return {
    ctx,
    service,
    credentials,
    authorizationServer,
    mcp,
    clock,
    events,
    dispose: async () => {
      await ctx.fiber.dispose()
      await mcp.close()
    },
  }
}

/** Approve the sign-in the engine announces, the way a human pasting the callback URL would. */
function approvingInteraction(authorizationServer: AuthorizationServerFixture): AuthorizationInteraction {
  let authorizationUrl: string | undefined
  return {
    notify: (notice) => { authorizationUrl ??= notice.url },
    prompt: () => {
      if (authorizationUrl === undefined) return Promise.reject(new Error('no authorization URL was announced'))
      return Promise.resolve(authorizationServer.approve(authorizationUrl))
    },
  }
}

async function signIn(h: RealHarness): Promise<void> {
  await expect(h.ctx.authorization.begin({
    key: h.service.recordKeyFor('github'),
    interaction: approvingInteraction(h.authorizationServer),
  })).resolves.toEqual({ status: 'authorized' })
}

async function ping(h: RealHarness): Promise<void> {
  const result = await h.ctx.tools.execute({ signal: testToolSignal, callId: 'call' as never, name: 'mcp__srv__ping', arguments: {} })
  expect(result.isError, JSON.stringify(result)).toBe(false)
}

/**
 * A tool call whose refresh may commit a narrower grant: the invalidation
 * that commit raises fences the generation the call is riding, so the call
 * itself may fail as a closed connection while consumers re-establish.
 */
async function pingAcrossRefreshBounce(h: RealHarness): Promise<void> {
  const result = await h.ctx.tools.execute({ signal: testToolSignal, callId: 'call' as never, name: 'mcp__srv__ping', arguments: {} })
  if (result.isError) expect(JSON.stringify(result)).toContain('Connection closed')
}

function tokenRequests(h: RealHarness): number {
  return h.authorizationServer.calls.filter(call => call.url.pathname === '/token').length
}

describe('nativeMcpConnections with the real OAuth engine', () => {
  let h: RealHarness | undefined

  afterEach(async () => {
    await h?.dispose()
    h = undefined
  })

  it('signs in through the SDK flow, serves tools, and refreshes proactively and after a 401 without invalidating consumers', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    expect((await h.service.describe('github'))?.state).toBe('auth-required')
    expect(h.ctx.tools.get('mcp__srv__ping')).toBeUndefined()

    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
    expect(new Set(h.mcp.authorization)).toEqual(new Set(['Bearer access-secret-2']))
    expect(await h.service.describe('github')).toMatchObject({ state: 'authorized', consumers: ['srv'] })
    // The engine's own commit reached the store (record-updated fired) without a stale withdrawal.
    expect(h.events.map(event => event.kind)).toEqual(['authorized'])
    const settled = await epochOf(h)

    // Proactive refresh: the token expires, the next tool call refreshes and succeeds with no bounce.
    h.clock.now += 3_600_000
    await ping(h)
    expect(tokenRequests(h)).toBe(2)
    expect(h.events.map(event => event.kind)).toEqual(['authorized', 'refreshed'])
    expect(await epochOf(h)).toBe(settled)
    expect(h.ctx.tools.get('mcp__srv__ping')).toBeDefined()

    // 401 refresh: the resource stops accepting the token; one shared refresh, the call still succeeds, no bounce.
    h.authorizationServer.accessTokens.clear()
    await ping(h)
    expect(tokenRequests(h)).toBe(3)
    expect(await epochOf(h)).toBe(settled)
    expect(h.mcp.authorization.at(-1)).toBe('Bearer access-secret-4')
    expect(h.ctx.tools.get('mcp__srv__ping')).toBeDefined()
  })

  it('invalidates cached tools when the first refresh narrows the granted scope, and only then', async () => {
    h = await mountRealHarness({ scopes: ['mcp', 'tools:write'] })
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const settled = await epochOf(h)

    // Reordered scope set: the same grant.
    h.authorizationServer.options.scopeInResponse = 'tools:write mcp'
    h.clock.now += 3_600_000
    await ping(h)
    expect(await epochOf(h)).toBe(settled)

    // A repeated scope token is still the same set.
    h.authorizationServer.options.scopeInResponse = 'mcp tools:write mcp'
    h.clock.now += 3_600_000
    await ping(h)
    expect(await epochOf(h)).toBe(settled)

    // Omitted scope: RFC 6749 says the grant is unchanged.
    h.authorizationServer.options.scopeInResponse = 'omit'
    h.clock.now += 3_600_000
    await ping(h)
    expect(await epochOf(h)).toBe(settled)
    expect((await h.service.describe('github'))?.state).toBe('authorized')

    // Narrowed on refresh: consumers re-establish against the narrower grant.
    h.authorizationServer.options.scopeInResponse = 'mcp'
    h.clock.now += 3_600_000
    await pingAcrossRefreshBounce(h)
    await vi.waitFor(async () => { expect(await epochOf(h!)).toBe(settled + 1) })
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
    expect(await epochOf(h)).toBe(settled + 1)
  })

  it('seeds the scope baseline from the stored grant after a Host restart, so the first narrowing still invalidates', async () => {
    const first = await mountRealHarness({ scopes: ['mcp', 'tools:write'] })
    await signIn(first)
    const records = first.credentials.records
    const authorizationServer = first.authorizationServer
    const mcp = first.mcp
    await first.ctx.fiber.dispose()

    h = await mountRealHarness({ scopes: ['mcp', 'tools:write'], records, authorizationServer, mcp })
    await apply(h.ctx, hostConfig())
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const settled = await epochOf(h)
    expect(h.events).toEqual([])

    authorizationServer.options.scopeInResponse = 'mcp'
    h.clock.now += 3_600_000
    await pingAcrossRefreshBounce(h)
    expect(h.events.map(event => event.kind)).toEqual(['refreshed'])
    await vi.waitFor(async () => { expect(await epochOf(h!)).toBe(settled + 1) })
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
  })

  it('withdraws consumers on an external deletion and on revocation while ignoring its own record writes', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const settled = await epochOf(h)

    await h.service.removeGrant('github')
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect(await epochOf(h)).toBe(settled + 1)
    expect((await h.service.describe('github'))?.state).toBe('auth-required')

    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const reauthorized = await epochOf(h)
    await expect(h.service.revoke('github')).resolves.toEqual({ local: 'revoked', remote: 'succeeded' })
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect((await h.service.describe('github'))?.state).toBe('revoked')
    // Exactly one withdrawal for the revocation: the tombstone's own record-updated was recognized as the engine's.
    expect(await epochOf(h)).toBe(reauthorized + 1)

    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
  })

  it('mounts the production engine by default, uses a pre-registered client id, and treats an omitted scope on an unscoped grant as unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings, { doc: { [SETTINGS_NS]: { github: connectionEntry({ clientId: 'public-client' }) } } })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(NativeMcpConnectionsService)
    const service = ctx.get('nativeMcpConnections') as NativeMcpConnectionsService
    expect(await service.describe('github')).toMatchObject({ state: 'auth-required', configured: true })
    await ctx.fiber.dispose()

    h = await mountRealHarness({ scopes: [], serverOptions: { scopeInResponse: 'omit' } })
    await h.ctx.settings.update(SETTINGS_NS, { github: { clientId: 'public-client' } })
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    expect(h.authorizationServer.calls.filter(call => call.url.pathname === '/register')).toHaveLength(0)
    const committed = (): string[] => h!.events.filter(event => event.kind !== 'disposed').map(event => event.kind)
    expect(h.events.find(event => event.kind === 'authorized')).toMatchObject({ grantedScope: undefined })
    const settled = await epochOf(h)
    h.clock.now += 3_600_000
    await ping(h)
    expect(committed()).toEqual(['authorized', 'refreshed'])
    expect(await epochOf(h)).toBe(settled)
  })

  it('withdraws consumers on an external write that keeps the epoch but changes the record, and on a restored older own record', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const key = h.service.recordKeyFor('github')
    const signedIn = structuredClone(h.credentials.records.get(key))
    h.clock.now += 3_600_000
    await ping(h)
    const settled = await epochOf(h)
    const refreshed = h.credentials.records.get(key) as { kind: 'grant'; payload: Record<string, unknown> }
    expect(refreshed.payload['epoch']).toBe(2)

    // Same epoch, different content: a native modifyRecord from elsewhere tombstones the grant in place.
    await h.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant',
      payload: { ...refreshed.payload, status: 'revoked', tokens: undefined, tokensIssuedAt: undefined },
    }))
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect(await epochOf(h)).toBe(settled + 1)
    expect((await h.service.describe('github'))?.state).toBe('revoked')

    // The older own record put back by someone else is an external change too, even though this engine once
    // wrote it: consumers are withdrawn and re-judge it — its expired token refreshes with a refresh token the
    // server already rotated away, so the server rejects it and the grant ends invalidated, not silently reused.
    await h.credentials.modifyRecord(key, () => Promise.resolve(structuredClone(signedIn)))
    await vi.waitFor(async () => { expect(await epochOf(h!)).toBeGreaterThanOrEqual(settled + 2) })
    await vi.waitFor(async () => { expect((await h!.service.describe('github'))?.state).toBe('auth-required') })
    expect(h.ctx.tools.get('mcp__srv__ping')).toBeUndefined()

    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
  })

  it('withdraws consumers at the first synchronous step of revocation, before the tombstone is stored, and bounces once', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const settled = await epochOf(h)

    const gate = Promise.withResolvers<undefined>()
    const working = h.credentials.modifyRecord.bind(h.credentials)
    h.credentials.modifyRecord = async (key, mutate) => { await gate.promise; return working(key, mutate) }
    const revocation = h.service.revoke('github')
    // Withdrawn synchronously: no await has passed, nothing durable has changed.
    expect(await epochOf(h)).toBe(settled + 1)
    expect((h.credentials.records.get(h.service.recordKeyFor('github')) as { payload: { status: string } }).payload.status).toBe('authorized')
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    await new Promise(resolve => setTimeout(resolve, 50))
    const mcpRequests = h.mcp.authorization.length
    const tokenRequests = h.authorizationServer.calls.filter(call => call.url.pathname === '/token').length
    // A consumer re-evaluating now is held: no bearer, no refresh, no MCP request.
    const binding = h.service.acquire('github', { serverName: 'late' })
    await expect(binding.connect(new AbortController().signal)).resolves.toBeUndefined()
    binding.release()
    expect(h.mcp.authorization.length).toBe(mcpRequests)
    expect(h.authorizationServer.calls.filter(call => call.url.pathname === '/token')).toHaveLength(tokenRequests)

    gate.resolve(undefined)
    await expect(revocation).resolves.toEqual({ local: 'revoked', remote: 'succeeded' })
    h.credentials.modifyRecord = working
    await new Promise(resolve => setTimeout(resolve, 20))
    // The stored tombstone is the engine's own write: no second withdrawal.
    expect(await epochOf(h)).toBe(settled + 1)
    expect((await h.service.describe('github'))?.state).toBe('revoked')

    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
  })

  it('keeps refusing a locally revoked grant across a config swap, a removal and re-add, and consumer pruning until a new sign-in', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const key = h.service.recordKeyFor('github')

    // The tombstone write fails: the grant is revoked in this Host, the store still holds it.
    const working = h.credentials.modifyRecord.bind(h.credentials)
    h.credentials.modifyRecord = () => Promise.reject(new Error('store offline'))
    await expect(h.service.revoke('github')).rejects.toMatchObject({ code: 'STORE' })
    h.credentials.modifyRecord = working
    expect((h.credentials.records.get(key) as { payload: { status: string } }).payload.status).toBe('authorized')
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect((await h.service.describe('github'))?.state).toBe('revoked')

    // An innocuous edit swaps the engine: the fresh engine must not serve the stored grant.
    await h.ctx.settings.update(SETTINGS_NS, { github: { requestTimeoutMs: 20_000 } })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.ctx.tools.get('mcp__srv__ping')).toBeUndefined()
    expect((await h.service.describe('github'))?.state).toBe('revoked')
    const probe = h.service.acquire('github', { serverName: 'probe' })
    await expect(probe.connect(new AbortController().signal)).resolves.toBeUndefined()
    probe.release()

    // A fresh Host over the same store, inheriting the fixtures (the first Host is disposed, not its servers).
    const first = h
    await first.ctx.fiber.dispose()
    h = await mountRealHarness({ records: first.credentials.records, authorizationServer: first.authorizationServer, mcp: first.mcp })
    // A fresh Host has no memory of the failed tombstone: only durable state governs after a restart.
    expect((await h.service.describe('github'))?.state).toBe('authorized')
    await apply(h.ctx, hostConfig())
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const restartedStore = h.credentials.modifyRecord.bind(h.credentials)
    h.credentials.modifyRecord = () => Promise.reject(new Error('store offline'))
    await expect(h.service.revoke('github')).rejects.toMatchObject({ code: 'STORE' })
    h.credentials.modifyRecord = restartedStore
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    const settled = await epochOf(h)
    await h.ctx.settings.replace(SETTINGS_NS, {})
    await vi.waitFor(async () => { expect((await h!.service.describe('github'))?.configured).toBe(false) })
    await h.ctx.settings.replace(SETTINGS_NS, { github: connectionEntry() })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.ctx.tools.get('mcp__srv__ping')).toBeUndefined()
    expect((await h.service.describe('github'))?.state).toBe('revoked')
    expect(await epochOf(h)).toBeGreaterThan(settled)

    // Only a new, successful explicit sign-in lifts the refusal.
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
  })

  it('withdraws on an external write even when the engine commits atop it before the judgement read returns', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    const key = h.service.recordKeyFor('github')
    const settled = await epochOf(h)
    const current = h.credentials.records.get(key) as { kind: 'grant'; payload: Record<string, unknown> }

    // Only the judgement's read is slow; the engine's own reads pass through.
    const gate = Promise.withResolvers<undefined>()
    const read = h.credentials.readRecord.bind(h.credentials)
    let held = false
    h.credentials.readRecord = (readKey) => {
      if (held) return read(readKey)
      held = true
      const snapshot = h!.credentials.records.get(readKey)
      return gate.promise.then(() => snapshot)
    }
    // Another writer re-issues the same grant under a new epoch (as a second process's refresh would).
    await h.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { ...current.payload, epoch: 41 } }))
    // The engine refreshes atop that record and commits its own successor before the judgement read returns.
    h.clock.now += 3_600_000
    await ping(h)
    expect((h.credentials.records.get(key) as { payload: { epoch: number } }).payload.epoch).toBe(42)
    expect(h.events.map(event => event.kind)).toEqual(['authorized', 'refreshed'])
    expect(await epochOf(h)).toBe(settled)

    gate.resolve(undefined)
    await vi.waitFor(async () => { expect(await epochOf(h!)).toBe(settled + 1) })
    h.credentials.readRecord = read
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    await ping(h)
  })

  it('survives a config swap and a removal/re-add with the same consumer, reusing a grant whose binding still matches', async () => {
    h = await mountRealHarness()
    await apply(h.ctx, hostConfig())
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    // A scope change rebinds: the stored grant no longer matches, so the connection needs a new sign-in.
    await h.ctx.settings.update(SETTINGS_NS, { github: { scopes: ['mcp', 'admin'] } })
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    await vi.waitFor(async () => {
      expect(await h!.service.describe('github')).toMatchObject({ state: 'auth-required', consumers: ['srv'] })
    })
    h.authorizationServer.options.scopeInResponse = 'mcp admin'
    await signIn(h)
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    // Removal then re-add with the same settings reuses the grant for the same, still-bound consumer.
    await h.ctx.settings.replace(SETTINGS_NS, {})
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    await h.ctx.settings.replace(SETTINGS_NS, { github: connectionEntry({ scopes: ['mcp', 'admin'] }) })
    await vi.waitFor(() => { expect(h!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    expect(await h.service.describe('github')).toMatchObject({ configured: true, state: 'authorized', consumers: ['srv'] })
    expect(h.authorizationServer.calls.filter(call => call.url.pathname === '/register')).toHaveLength(2)
  })
})

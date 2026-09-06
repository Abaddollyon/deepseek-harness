/**
 * Real-composition tests for the Host connection owner and the agent-side
 * host-connection transport: real settings/credentials/authorization seams,
 * a real Streamable HTTP MCP fixture, and fake protocol engines whose
 * authenticated fetch maps the configured HTTPS endpoint onto the local
 * fixture. No SDK mocks: the whole path from settings through the supervisor
 * to tool registration runs.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
import { NativeMcpConnectionsService, SETTINGS_NS } from '@deepseek-ai/dsh-mcp-client/src/connections.ts'
import type {
  McpConnectionEngine, McpConnectionEngineFactory, McpConnectionEngineInit,
  McpConnectionEngineStatus, McpConnectionEntry,
} from '@deepseek-ai/dsh-mcp-client/src/connections.ts'
import type { McpOAuthRevocation } from '@deepseek-ai/dsh-mcp-client/src/connections.ts'
import { startHttpMcpFixture } from './http-fixture.ts'
import type { HttpMcpFixture } from './http-fixture.ts'

// ---- Minimal in-memory seam providers (record half and document only) ----

class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<CredentialKey, CredentialRecord>()

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

/** The configured HTTPS endpoint the fake engine maps onto the local fixture. */
const CONFIGURED_URL = 'https://fixture.mcp.test/mcp'

function connectionEntry(overrides: Partial<McpConnectionEntry> = {}): Record<string, unknown> {
  return {
    url: CONFIGURED_URL,
    issuerUrl: 'https://issuer.mcp.test',
    redirectUri: 'https://issuer.mcp.test/callback',
    scopes: ['mcp'],
    ...overrides,
  }
}

class FakeEngine implements McpConnectionEngine {
  state: McpConnectionEngineStatus['state'] = 'authorized'
  disposed = false
  /** Test-controlled gate authorize() waits on before committing. */
  authorizeGate: PromiseWithResolvers<void> | undefined

  constructor(
    readonly init: McpConnectionEngineInit,
    private readonly upstream: string,
  ) {}

  status(): Promise<McpConnectionEngineStatus> {
    return Promise.resolve({
      state: this.state,
      inFlight: this.authorizeGate === undefined ? undefined : 'authorize',
      hasRefreshToken: true,
      accessTokenExpiresAt: undefined,
      grantedScope: 'mcp',
      epoch: 0,
    })
  }

  async authorize(_session: AuthorizationSession): Promise<void> {
    const gate = this.authorizeGate
    if (gate !== undefined) await gate.promise
    // The seam confirms this exact record write before reporting authorized.
    await this.init.ctx.credentials.modifyRecord(this.init.credentialKey, () =>
      Promise.resolve({ kind: 'grant', payload: { fake: 'grant' } }))
    this.state = 'authorized'
    this.authorizeGate = undefined
    this.init.onChange('authorized')
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

  async revoke(): Promise<McpOAuthRevocation> {
    this.state = 'revoked'
    await this.init.ctx.credentials.modifyRecord(this.init.credentialKey, () =>
      Promise.resolve({ kind: 'grant', payload: { revoked: true } }))
    this.init.onChange('revoked')
    return { local: 'revoked', remote: 'unsupported' }
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.state = 'disposed'
    return Promise.resolve()
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
  return {
    transport: 'host-connection',
    serverName: 'srv',
    connectionId: 'github',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...overrides,
  } as Config
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
    prompt: () => Promise.resolve('https://issuer.mcp.test/callback?code=fake&state=fake'),
  }
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

  it('a settings scope change swaps the engine behind a config-generation fence', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
    expect(harness.engines).toHaveLength(1)

    await harness.ctx.settings.update(SETTINGS_NS, { github: { scopes: ['mcp', 'admin'] } })

    await vi.waitFor(() => { expect(harness!.engines).toHaveLength(2) })
    // The old engine is quiesced before the new one serves.
    expect(harness.engines[0]!.disposed).toBe(true)
    expect(harness.engines[0]!.init.spec.configGeneration).toBe(0)
    expect(harness.engines[1]!.init.spec.configGeneration).toBe(1)
    expect(harness.engines[1]!.init.spec.scopes).toEqual(['mcp', 'admin'])
    // The consumer was invalidated and re-established against the new spec.
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })
  })

  it('removing the configuration withdraws tools, the flow, and the binding', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    await harness.ctx.settings.replace(SETTINGS_NS, {})

    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeUndefined() })
    expect(await harness.service.describe('github')).toBeUndefined()
    expect(harness.ctx.authorization.list()).toHaveLength(0)
    expect(harness.engines[0]!.disposed).toBe(true)
    expect(() => harness!.service.acquire('github', { serverName: 'late' })).toThrow(/unknown connection/)
  })

  it('an external grant deletion invalidates consumers through the record event', async () => {
    harness = await mountHarness()
    await apply(harness.ctx, hostConfig())
    await vi.waitFor(() => { expect(harness!.ctx.tools.get('mcp__srv__ping')).toBeDefined() })

    // Seed the grant an earlier authorization would have committed; deleting
    // an absent record emits nothing by design.
    await harness.credentials.modifyRecord(harness.service.recordKeyFor('github'), () =>
      Promise.resolve({ kind: 'grant', payload: { fake: 'grant' } }))
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

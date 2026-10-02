import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP machine permission policy', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function ownedRequest(overrides: Partial<ApprovalRequest> = {}): Promise<ApprovalRequest> {
    if (harness === undefined) throw new Error('missing harness')
    await harness.ctx.plugin(ApprovalService)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-9'), name: 'bash', arguments: '{}' })
    return { agent, toolName: 'bash', callId: ToolCallId('call-9'), ...overrides }
  }

  it('maps the two advertised one-shot choices', async () => {
    harness = await makeBridgeHarness()
    harness.onPermission = () => {
      expect(harness?.sessionUpdates.at(-1)?.update).toMatchObject({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-9',
      })
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    }
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request(request)).resolves.toBe('allowed-once')
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: request.agent.session.id,
      toolCall: { toolCallId: 'call-9' },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    })

    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('maps cancellation and unknown choices without granting access', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request(request)).resolves.toBe('cancelled')
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'unknown-grant' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('withdraws the client prompt once another answerer settles the request', async () => {
    harness = await makeBridgeHarness()
    const prompted = Promise.withResolvers<AbortSignal>()
    // ACP lets a client answer `$/cancel_request` with a request-cancelled error.
    harness.onPermission = (_params, signal) => new Promise((_resolve, reject) => {
      prompted.resolve(signal)
      signal.addEventListener('abort', () => { reject(RequestError.requestCancelled()) }, { once: true })
    })
    const request = await ownedRequest()
    let forwarded: Promise<ApprovalOutcome> | undefined
    harness.ctx.on('approval/request', async (_req, next) => {
      forwarded = next()
      await prompted.promise
      return 'rejected'
    }, { prepend: true })

    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')

    await expect(forwarded).resolves.toBe('cancelled')
    expect((await prompted.promise).aborted).toBe(true)
  })

  it('does not prompt the client for a request withdrawn while updates drain', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    let forwarded: Promise<ApprovalOutcome> | undefined
    harness.ctx.on('approval/request', (_req, next) => {
      forwarded = next()
      return forwarded
    }, { prepend: true })
    const controller = new AbortController()

    const outcome = harness.ctx.approval.request({ ...request, signal: controller.signal })
    controller.abort()

    await expect(outcome).resolves.toBe('cancelled')
    await expect(forwarded).resolves.toBe('cancelled')
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('fails closed when the client errors the permission request', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    harness.onPermission = () => { throw new Error('client gone') }
    await expect(harness.ctx.approval.request(request)).resolves.toBe('unavailable')
  })

  it('delegates a same-id foreign agent', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    const events = [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }]
    const foreign = {
      session: {
        id: request.agent.session.id,
        seq: events.length,
        eventAt: (seq: number) => events[seq],
        snapshotEvents: () => events,
        append: () => ({}),
      },
    } as unknown as Agent
    await expect(harness.ctx.approval.request({ agent: foreign, toolName: 'bash', callId: ToolCallId('call') }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('delegates requests that have no protocol tool-call identity', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request({ agent: request.agent, toolName: request.toolName }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })
})

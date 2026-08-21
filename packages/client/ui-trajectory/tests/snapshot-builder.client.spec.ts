import { describe, expect, it } from 'vitest'
import type { RequestView } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryContribution, TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
} from '../src/client/trajectory-contract.ts'
import {
  registerTrajectoryConversationView,
  TrajectorySnapshotBuilder,
  type TrajectorySnapshotBuilderOperation,
  trajectoryViewDefinition,
} from '../src/client/trajectory-snapshot-builder.ts'

function operationCounter(): {
  readonly counts: Map<TrajectorySnapshotBuilderOperation, number>
  readonly instrumentation: { onOperation(operation: TrajectorySnapshotBuilderOperation): void }
  reset(): void
} {
  const counts = new Map<TrajectorySnapshotBuilderOperation, number>()
  return {
    counts,
    instrumentation: {
      onOperation(operation) {
        counts.set(operation, (counts.get(operation) ?? 0) + 1)
      },
    },
    reset() {
      counts.clear()
    },
  }
}

function assistantRequest(startSeq: number, step: number): Extract<RequestView, { purpose: 'assistant' }> {
  return {
    purpose: 'assistant',
    startSeq,
    turn: 1,
    step,
    startedAt: startSeq,
    completedAt: startSeq + 1,
    status: 'complete',
  }
}

function contribution(
  key: string,
  anchorSeq: number,
  data: TrajectoryContribution,
): TrajectoryConversationViewNode {
  return {
    key, kind: key, id: key, target: 'trajectory', anchorSeq,
    location: { kind: 'session' },
    data,
  }
}

function stepLocation(turn: number, step: number): TrajectoryRequestHeaderState['location'] {
  const data = { get: () => undefined }
  const stepLocation = {
    turn,
    step,
    start: undefined,
    end: undefined,
    status: 'unknown' as const,
    data,
  }
  const turnLocation = {
    turn,
    start: undefined,
    end: undefined,
    status: 'unknown' as const,
    steps: [stepLocation],
    data,
  }
  return { kind: 'step', turn: turnLocation, step: stepLocation }
}

function compactionRequest(startSeq: number): Extract<RequestView, { purpose: 'compaction' }> {
  return {
    purpose: 'compaction',
    startSeq,
    turn: null,
    step: 0,
    startedAt: startSeq,
    completedAt: null,
    status: 'running',
  }
}

describe('TrajectorySnapshotBuilder', () => {
  it('inherits one request header across requests without repeating its prompt change', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'one initial prompt',
      tools: [],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      {
        key: 'header',
        kind: 'trajectory-request-header',
        id: '2',
        target: 'trajectory',
        anchorSeq: 2,
        location: { kind: 'session' },
        data: {
          kind: 'request-header',
          header: {
            seq: 2,
            time: 2,
            prompt,
            change: { seq: 2, time: 2, kind: 'initial' },
            location: { kind: 'session' },
          },
        },
      },
      ...[assistantRequest(3, 1), assistantRequest(5, 2)].map(request => ({
        key: `assistant:${request.step}`,
        kind: 'trajectory-assistant-step',
        id: `1:${request.step}`,
        target: 'trajectory' as const,
        anchorSeq: request.startSeq,
        location: { kind: 'session' as const },
        data: { kind: 'assistant' as const, partial: null, request },
      })),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['one initial prompt', 'one initial prompt'])
    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })

  it('indexes exact step headers and the active tool schema without backward scans', () => {
    const basePrompt = {
      config: { provider: 'test', model: 'base' },
      system: 'base prompt',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    }
    const exactPrompt = {
      config: { provider: 'test', model: 'exact' },
      system: 'exact prompt',
      tools: [{ name: 'edit', description: 'Edit', parameters: { type: 'object' } }],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      contribution('header:base', 2, {
        kind: 'request-header',
        header: {
          seq: 2,
          time: 2,
          prompt: basePrompt,
          change: { seq: 2, time: 2, kind: 'initial' },
          location: { kind: 'session' },
        },
      }),
      contribution('assistant:1', 3, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(3, 1),
      }),
      contribution('assistant:2', 5, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(5, 2),
      }),
      contribution('header:exact', 6, {
        kind: 'request-header',
        header: {
          seq: 6,
          time: 6,
          prompt: exactPrompt,
          change: { seq: 6, time: 6, kind: 'system', previous: basePrompt },
          location: stepLocation(1, 2),
        },
      }),
      contribution('tool', 7, {
        kind: 'tool',
        root: {
          callId: 'call-edit',
          name: 'edit',
          argsRaw: '{}',
          turn: 1,
          step: 2,
          time: 7,
          callView: null,
          subCalls: [],
        },
      }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['base prompt', 'exact prompt'])
    expect(snapshot.callSchemas.get('call-edit')).toEqual(exactPrompt.tools[0])
  })

  it('applies session boundaries and turn errors with linear request indexes', () => {
    const nodes: TrajectoryConversationViewNode[] = [
      ...[assistantRequest(1, 1), assistantRequest(3, 2)].map(request => contribution(
        `assistant:${request.step}`,
        request.startSeq,
        { kind: 'assistant', partial: null, request },
      )),
      contribution('turn-end', 5, {
        kind: 'turn-end',
        turn: 1,
        time: 5,
        error: 'turn failed',
      }),
      contribution('compact:10', 10, {
        kind: 'compaction',
        request: compactionRequest(10),
      }),
      contribution('compact:12', 12, {
        kind: 'compaction',
        request: compactionRequest(12),
      }),
      contribution('session-end:14', 14, { kind: 'session-end', seq: 14, time: 14 }),
      contribution('session-end:16', 16, { kind: 'session-end', seq: 16, time: 16 }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests).toMatchObject([
      { purpose: 'assistant', step: 1, status: 'complete' },
      { purpose: 'assistant', step: 2, status: 'error', error: 'turn failed' },
      { purpose: 'compaction', startSeq: 10, status: 'error', completedAt: 16 },
      { purpose: 'compaction', startSeq: 12, status: 'error', completedAt: 14 },
    ])
  })

  it('keeps cached contribution order across content updates and structural inserts', () => {
    const builder = new TrajectorySnapshotBuilder()
    const first = contribution('assistant:1', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })
    const last = contribution('assistant:3', 5, {
      kind: 'assistant', partial: null, request: assistantRequest(5, 3),
    })
    expect(builder.replace({ nodes: [last, first] }).requests.map(request => request.startSeq))
      .toEqual([1, 5])

    const updatedLast = contribution('assistant:3', 5, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(5, 3), status: 'error', error: 'failed' },
    })
    expect(builder.apply({ upserts: [updatedLast] }).requests.map(request => request.startSeq))
      .toEqual([1, 5])

    const middle = contribution('assistant:2', 3, {
      kind: 'assistant', partial: null, request: assistantRequest(3, 2),
    })
    expect(builder.apply({ upserts: [middle] }).requests.map(request => request.startSeq))
      .toEqual([1, 3, 5])
  })

  it('patches a tail partial without visiting settled contributions', () => {
    const operations = operationCounter()
    const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
    const settled = contribution('assistant:1', 1, {
      kind: 'assistant',
      node: {
        kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'done' }],
      },
      partial: null,
      request: assistantRequest(1, 1),
    })
    const streaming = (text: string) => contribution('assistant:2', 3, {
      kind: 'assistant',
      partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text }] },
      request: { ...assistantRequest(3, 2), completedAt: null, status: 'running' },
    })
    builder.replace({ nodes: [settled, streaming('a')] })
    operations.reset()
    const first = builder.apply({ upserts: [streaming('ab')] })
    const second = builder.apply({ upserts: [streaming('abc')] })

    expect(operations.counts).toEqual(new Map([['section-patch', 2]]))
    expect(second.eventNodes).toBe(first.eventNodes)
    expect(second.eventLocations).toBe(first.eventLocations)
    expect(second.requests).toBe(first.requests)
    expect(second.callSchemas).toBe(first.callSchemas)
    expect(second.runningCalls).toBe(first.runningCalls)
    expect(second.partial).not.toBe(first.partial)
    expect(second.partial?.blocks).toEqual([{ kind: 'text', text: 'abc' }])
  })

  it('republishes the identical snapshot when an upsert moves nothing', () => {
    const builder = new TrajectorySnapshotBuilder()
    const node = contribution('assistant:1', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })
    const first = builder.replace({ nodes: [node] })
    expect(builder.apply({ upserts: [node] })).toBe(first)
  })

  it('appends a monotonic event without sorting or visiting prior contributions', () => {
    const operations = operationCounter()
    const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
    const settled = (seq: number) => contribution(`node:${seq}`, seq, {
      kind: 'node',
      node: {
        kind: 'assistant', seq, time: seq, turn: 1, step: seq,
        blocks: [{ kind: 'text', text: `step ${seq}` }],
      },
    })
    const before = builder.replace({ nodes: [settled(1), settled(2), settled(3)] })
    operations.reset()
    const after = builder.apply({ upserts: [settled(4)] })

    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))
    expect(after.eventNodes).not.toBe(before.eventNodes)
    for (const [index, node] of before.eventNodes.entries()) {
      expect(after.eventNodes[index]).toBe(node)
    }
    expect(after.eventNodes.at(-1)?.seq).toBe(4)
    expect(after.requests).toBe(before.requests)
    expect(after.callSchemas).toBe(before.callSchemas)
  })

  it('rebuilds only requests for a same-position request update', () => {
    const operations = operationCounter()
    const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
    const firstNode = contribution('assistant:1', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })
    const secondNode = contribution('assistant:2', 3, {
      kind: 'assistant', partial: null, request: assistantRequest(3, 2),
    })
    const before = builder.replace({ nodes: [firstNode, secondNode] })
    operations.reset()

    const after = builder.apply({ upserts: [contribution('assistant:2', 3, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(3, 2), status: 'error', error: 'failed' },
    })] })

    expect(operations.counts).toEqual(new Map([['section-patch', 1]]))
    expect(after.requests).not.toBe(before.requests)
    expect(after.requests.at(-1)).toMatchObject({ status: 'error', error: 'failed' })
    expect(after.eventNodes).toBe(before.eventNodes)
    expect(after.eventLocations).toBe(before.eventLocations)
    expect(after.callSchemas).toBe(before.callSchemas)
    expect(after.runningCalls).toBe(before.runningCalls)
  })

  it('keeps assistant, tool, and header hot paths bounded with a large settled prefix', () => {
    const operations = operationCounter()
    const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
    const settled = Array.from({ length: 256 }, (_, index) => contribution(`settled:${index}`, index + 1, {
      kind: 'node',
      node: {
        kind: 'assistant',
        seq: index + 1,
        time: index + 1,
        turn: index + 1,
        step: 1,
        blocks: [],
      },
    }))
    const assistant = contribution('assistant:hot', 257, {
      kind: 'assistant',
      node: { kind: 'assistant', seq: 257, time: 257, turn: 257, step: 1, blocks: [] },
      partial: null,
      request: { ...assistantRequest(257, 1), turn: 257 },
    })
    const runningTool = contribution('tool:hot', 258, {
      kind: 'tool',
      root: {
        callId: 'hot', name: 'read', argsRaw: '{}', turn: 257, step: 1,
        time: 258, callView: null, subCalls: [],
      },
    })
    builder.replace({ nodes: [...settled, assistant, runningTool] })

    operations.reset()
    const assistantUpdate = builder.apply({ upserts: [contribution('assistant:hot', 257, {
      kind: 'assistant',
      node: {
        kind: 'assistant', seq: 257, time: 259, turn: 257, step: 1,
        blocks: [{ kind: 'text', text: 'done' }],
      },
      partial: null,
      request: { ...assistantRequest(257, 1), turn: 257, status: 'error', error: 'failed' },
    })] })
    expect(operations.counts).toEqual(new Map([['section-patch', 1]]))
    expect(assistantUpdate.eventNodes).toHaveLength(257)
    expect(assistantUpdate.requests[0]).toMatchObject({ status: 'error' })

    operations.reset()
    const settledTool = builder.apply({ upserts: [contribution('tool:hot', 258, {
      kind: 'tool',
      root: {
        kind: 'tool-result', seq: 258, time: 260, callId: 'hot',
        call: { name: 'read', argsRaw: '{}' }, callTime: 258,
        content: [], isError: false, callView: null, resultView: null, subCalls: [],
      },
    })] })
    expect(operations.counts).toEqual(new Map([['section-patch', 1]]))
    expect(settledTool.runningCalls).toHaveLength(0)
    expect(settledTool.eventNodes.at(-1)).toMatchObject({ kind: 'tool-result' })

    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'hot prompt',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    }
    operations.reset()
    builder.apply({ upserts: [contribution('header:tail', 259, {
      kind: 'request-header',
      header: { seq: 259, time: 259, prompt, location: { kind: 'session' } },
    })] })
    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))

    operations.reset()
    const appendedAssistant = builder.apply({ upserts: [contribution('assistant:tail', 260, {
      kind: 'assistant',
      node: { kind: 'assistant', seq: 260, time: 260, turn: 258, step: 1, blocks: [] },
      partial: null,
      request: { ...assistantRequest(260, 1), turn: 258 },
    })] })
    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))
    expect(appendedAssistant.requests.at(-1)).toMatchObject({ prompt })

    operations.reset()
    const appendedTool = builder.apply({ upserts: [contribution('tool:tail', 261, {
      kind: 'tool',
      root: {
        callId: 'tail', name: 'read', argsRaw: '{}', turn: 258, step: 1,
        time: 261, callView: null, subCalls: [],
      },
    })] })
    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))
    expect(appendedTool.callSchemas.get('tail')?.name).toBe('read')

    const exactPrompt = { ...prompt, config: { provider: 'test', model: 'exact' } }
    operations.reset()
    const exactHeader = builder.apply({ upserts: [contribution('header:exact-tail', 262, {
      kind: 'request-header',
      header: {
        seq: 262,
        time: 262,
        prompt: exactPrompt,
        change: { seq: 262, time: 262, kind: 'initial' },
        location: stepLocation(258, 1),
      },
    })] })
    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))
    expect(exactHeader.requests.at(-1)).toMatchObject({ prompt: exactPrompt })
    expect(exactHeader.eventNodes.at(-1)).toMatchObject({ requestConfig: exactPrompt.config })
    expect(exactHeader.requests.at(-1)).toMatchObject({ promptChange: { kind: 'initial' } })

    operations.reset()
    builder.apply({ upserts: [contribution('assistant:tail', 260, {
      kind: 'assistant',
      node: { kind: 'assistant', seq: 260, time: 263, turn: 258, step: 1, blocks: [] },
      partial: null,
      request: { ...assistantRequest(260, 1), turn: 258, status: 'error', error: 'again' },
    })] })
    expect(operations.counts).toEqual(new Map([['section-patch', 1]]))

    operations.reset()
    builder.apply({ upserts: [contribution('tool:tail', 261, {
      kind: 'tool',
      root: {
        callId: 'tail', name: 'read', argsRaw: '{"path":"x"}', turn: 258, step: 1,
        time: 264, callView: null, subCalls: [],
      },
    })] })
    expect(operations.counts).toEqual(new Map([['section-patch', 1]]))

    operations.reset()
    builder.apply({ upserts: [contribution('tool:second-tail', 263, {
      kind: 'tool',
      root: {
        callId: 'second-tail', name: 'read', argsRaw: '{}', turn: 258, step: 1,
        time: 265, callView: null, subCalls: [],
      },
    })] })
    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))

    operations.reset()
    const noRequestNode = builder.apply({ upserts: [contribution('assistant:no-request', 264, {
      kind: 'assistant',
      node: { kind: 'assistant', seq: 264, time: 264, turn: 259, step: 1, blocks: [] },
      partial: null,
    })] })
    expect(operations.counts).toEqual(new Map([
      ['tail-append', 1],
      ['section-patch', 1],
    ]))
    expect(noRequestNode.eventNodes.at(-1)).toMatchObject({ seq: 264 })
  })

  it('falls back only for projection dependency changes and patches indexed batches', () => {
    const prompt = { config: { provider: 'test', model: 'base' }, system: '', tools: [] }
    const exact = { config: { provider: 'test', model: 'exact' }, system: '', tools: [] }
    const builder = new TrajectorySnapshotBuilder()
    builder.replace({ nodes: [
      contribution('header:base', 1, {
        kind: 'request-header',
        header: { seq: 1, time: 1, prompt, location: { kind: 'session' } },
      }),
      contribution('assistant', 2, {
        kind: 'assistant', partial: null, request: assistantRequest(2, 1),
      }),
      contribution('header:exact', 3, {
        kind: 'request-header',
        header: { seq: 3, time: 3, prompt: exact, location: stepLocation(1, 2) },
      }),
    ] })
    expect(builder.apply({ upserts: [contribution('assistant', 2, {
      kind: 'assistant', partial: null, request: assistantRequest(2, 2),
    })] }).requests[0]).toMatchObject({ prompt: exact })

    const presence = new TrajectorySnapshotBuilder()
    presence.replace({ nodes: [contribution('assistant', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })] })
    expect(presence.apply({ upserts: [contribution('assistant', 1, {
      kind: 'assistant', partial: null,
    })] }).requests).toHaveLength(0)

    const indexed = new TrajectorySnapshotBuilder()
    indexed.replace({ nodes: [contribution('assistant', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })] })
    indexed.apply({ upserts: [contribution('assistant', 1, {
      kind: 'assistant', partial: null, request: { ...assistantRequest(1, 1), turn: 2 },
    })] })
    const batchPrompt = { config: { provider: 'test', model: 'batch' }, system: '', tools: [] }
    const batch = indexed.apply({ upserts: [
      contribution('header:batch', 2, {
        kind: 'request-header',
        header: { seq: 2, time: 2, prompt: batchPrompt, location: stepLocation(2, 1) },
      }),
      contribution('assistant', 1, {
        kind: 'assistant', partial: null, request: { ...assistantRequest(1, 1), turn: 2 },
      }),
    ] })
    expect(batch.requests[0]).toMatchObject({ prompt: batchPrompt })
  })

  it('reapplies turn-ending request errors when assistant content changes', () => {
    const builder = new TrajectorySnapshotBuilder()
    builder.replace({ nodes: [
      contribution('assistant', 1, {
        kind: 'assistant', partial: null, request: assistantRequest(1, 1),
      }),
      contribution('turn', 2, {
        kind: 'turn-end', turn: 1, time: 2, error: 'turn failed',
      }),
    ] })

    expect(builder.apply({ upserts: [contribution('assistant', 1, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(1, 1), completedAt: null, status: 'running' },
    })] }).requests[0]).toMatchObject({
      status: 'error',
      error: 'turn failed',
      completedAt: 2,
    })
  })

  it('maintains shared step indexes and removes finalized tool projections locally', () => {
    const builder = new TrajectorySnapshotBuilder()
    builder.replace({ nodes: [
      contribution('assistant:one', 1, {
        kind: 'assistant', partial: null, request: assistantRequest(1, 1),
      }),
      contribution('assistant:two', 2, {
        kind: 'assistant', partial: null, request: assistantRequest(2, 1),
      }),
      contribution('tool', 3, {
        kind: 'tool',
        root: {
          kind: 'tool-result', seq: 3, time: 3, callId: 'call',
          call: { name: 'read', argsRaw: '{}' }, callTime: 2,
          content: [], isError: false, callView: null, resultView: null, subCalls: [],
        },
      }),
    ] })
    builder.apply({ upserts: [contribution('assistant:one', 1, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(1, 1), turn: 2 },
    })] })
    const running = builder.apply({ upserts: [contribution('tool', 3, {
      kind: 'tool',
      root: {
        callId: 'call', name: 'read', argsRaw: '{}', turn: 1, step: 1,
        time: 4, callView: null, subCalls: [],
      },
    })] })
    expect(running.eventNodes).toHaveLength(0)
    expect(running.runningCalls).toHaveLength(1)

    const prompt = { config: { provider: 'test', model: 'unused' }, system: '', tools: [] }
    expect(builder.apply({ upserts: [contribution('header:unmatched', 4, {
      kind: 'request-header',
      header: { seq: 4, time: 4, prompt, location: stepLocation(99, 99) },
    })] })).toBeDefined()
  })

  it('classifies every contribution kind without rebuilding contribution order', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'prompt',
      tools: [],
    }
    const runningTool: TrajectoryContribution = {
      kind: 'tool',
      root: {
        callId: 'call', name: 'read', argsRaw: '{}', turn: 1, step: 1,
        time: 1, callView: null, subCalls: [],
      },
    }
    const header = (time: number): TrajectoryContribution => ({
      kind: 'request-header',
      header: { seq: time, time, prompt, location: { kind: 'session' } },
    })
    const event = (seq: number): TrajectoryContribution => ({
      kind: 'node',
      node: { kind: 'assistant', seq, time: seq, turn: 1, step: seq, blocks: [] },
    })
    const cases: readonly [TrajectoryContribution, TrajectoryContribution][] = [
      [event(1), event(2)],
      [
        { kind: 'assistant', partial: null, request: assistantRequest(1, 1) },
        {
          kind: 'assistant',
          node: { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1, blocks: [] },
          partial: { turn: 1, step: 1, blocks: [] },
          request: assistantRequest(2, 1),
        },
      ],
      [runningTool, { ...runningTool, root: { ...runningTool.root, argsRaw: '{"path":"x"}' } }],
      [header(1), header(2)],
      [
        { kind: 'compaction', request: compactionRequest(1) },
        {
          kind: 'compaction',
          request: { ...compactionRequest(1), completedAt: 2, status: 'complete' },
        },
      ],
      [
        { kind: 'session-end', seq: 1, time: 1 },
        { kind: 'session-end', seq: 1, time: 2 },
      ],
      [
        { kind: 'turn-end', turn: 1, time: 1 },
        { kind: 'turn-end', turn: 1, time: 2, error: 'failed' },
      ],
      [event(1), { kind: 'turn-end', turn: 1, time: 2 }],
    ]

    for (const [beforeData, afterData] of cases) {
      const operations = operationCounter()
      const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
      const before = contribution('same', 1, beforeData)
      builder.replace({ nodes: [before] })
      expect(builder.apply({ upserts: [{ ...before }] })).toBeDefined()
      operations.reset()
      builder.apply({ upserts: [contribution('same', 1, afterData)] })
      expect(operations.counts.has('full-rebuild')).toBe(false)
    }

    const appendCases: readonly TrajectoryContribution[] = [
      event(1),
      { kind: 'assistant', partial: null },
      {
        kind: 'assistant',
        node: { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1, blocks: [] },
        partial: { turn: 1, step: 1, blocks: [] },
        request: assistantRequest(2, 1),
      },
      runningTool,
      header(3),
      { kind: 'compaction', request: compactionRequest(4) },
      { kind: 'session-end', seq: 5, time: 5 },
      { kind: 'turn-end', turn: 1, time: 6 },
    ]
    for (const [index, data] of appendCases.entries()) {
      const operations = operationCounter()
      const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
      builder.replace({ nodes: [] })
      operations.reset()
      builder.apply({ upserts: [contribution(`append:${index}`, index, data)] })
      expect(operations.counts.get('tail-append')).toBe(1)
      expect(operations.counts.has('full-rebuild')).toBe(false)
    }
  })

  it('rebuilds moved anchors and non-tail partials while preserving unaffected identities', () => {
    const operations = operationCounter()
    const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
    const first = contribution('assistant:1', 1, {
      kind: 'assistant',
      partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'old' }] },
    })
    const last = contribution('node:last', 3, {
      kind: 'node',
      node: { kind: 'assistant', seq: 3, time: 3, turn: 1, step: 2, blocks: [] },
    })
    const before = builder.replace({ nodes: [
      first,
      last,
      contribution('compact', 4, { kind: 'compaction', request: compactionRequest(4) }),
      contribution('session', 5, { kind: 'session-end', seq: 5, time: 5 }),
      contribution('turn', 6, { kind: 'turn-end', turn: 1, time: 6 }),
    ] })
    operations.reset()

    const partialUpdate = builder.apply({ upserts: [contribution('assistant:1', 1, {
      kind: 'assistant',
      partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'new' }] },
    })] })
    expect(operations.counts).toEqual(new Map([
      ['section-rebuild', 1],
      ['contribution-visit', 5],
    ]))
    expect(partialUpdate.eventNodes).toBe(before.eventNodes)

    operations.reset()
    const moved = builder.apply({ upserts: [contribution('node:last', 0, last.data)] })
    expect(operations.counts.get('full-rebuild')).toBe(1)
    expect(moved.eventNodes).toHaveLength(1)
  })

  it('inserts a tail contribution by event sequence without disturbing prior identities', () => {
    const builder = new TrajectorySnapshotBuilder()
    const later = contribution('node:later', 1, {
      kind: 'node',
      node: { kind: 'assistant', seq: 4, time: 4, turn: 1, step: 2, blocks: [] },
    })
    const before = builder.replace({ nodes: [later] })
    const after = builder.apply({ upserts: [contribution('node:earlier', 2, {
      kind: 'node',
      node: { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1, blocks: [] },
    })] })

    expect(after.eventNodes.map(node => node.seq)).toEqual([2, 4])
    expect(after.eventNodes[1]).toBe(before.eventNodes[0])
  })

  it('supports first-use appends and ignores unrelated contribution kinds in section rebuilds', () => {
    expect(new TrajectorySnapshotBuilder().apply({ upserts: [contribution('empty', 1, {
      kind: 'assistant', partial: null,
    })] })).toBeDefined()
    expect(new TrajectorySnapshotBuilder().apply({ upserts: [
      contribution('partial', 1, {
        kind: 'assistant',
        partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'a' }] },
      }),
      contribution('partial', 1, {
        kind: 'assistant',
        partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'ab' }] },
      }),
    ] }).partial).not.toBeNull()
    expect(new TrajectorySnapshotBuilder().apply({ upserts: [contribution('node', 1, {
      kind: 'node',
      node: { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] },
    })] }).eventNodes).toHaveLength(1)

    const prompt = { config: { provider: 'test', model: 'test' }, system: '', tools: [] }
    const builder = new TrajectorySnapshotBuilder()
    builder.replace({ nodes: [
      contribution('header', 1, {
        kind: 'request-header',
        header: { seq: 1, time: 1, prompt, location: { kind: 'session' } },
      }),
      contribution('node', 2, {
        kind: 'node',
        node: { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1, blocks: [] },
      }),
      contribution('assistant', 3, {
        kind: 'assistant', partial: null, request: assistantRequest(3, 1),
      }),
      contribution('compact', 4, { kind: 'compaction', request: compactionRequest(4) }),
      contribution('session', 5, { kind: 'session-end', seq: 5, time: 5 }),
      contribution('turn', 6, { kind: 'turn-end', turn: 1, time: 6 }),
    ] })
    builder.apply({ upserts: [contribution('assistant', 3, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(3, 1), status: 'error', error: 'failed' },
    })] })
    builder.apply({ upserts: [contribution('node', 2, {
      kind: 'node',
      node: { kind: 'assistant', seq: 2, time: 3, turn: 1, step: 1, blocks: [] },
    })] })

    const sameAnchor = new TrajectorySnapshotBuilder().replace({ nodes: [
      contribution('b', 1, { kind: 'turn-end', turn: 1, time: 1 }),
      contribution('a', 1, { kind: 'turn-end', turn: 1, time: 1 }),
    ] })
    expect(sameAnchor).toBeDefined()
  })

  it('derives finalized tools, nested schemas, configured messages, and interruption edges', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'prompt',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    }
    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes: [
      contribution('boundary:first', 1, { kind: 'session-end', seq: 1, time: 1 }),
      contribution('header', 2, {
        kind: 'request-header',
        header: { seq: 2, time: 2, prompt, location: { kind: 'session' } },
      }),
      contribution('assistant', 3, {
        kind: 'assistant',
        node: { kind: 'assistant', seq: 3, time: 3, turn: 2, step: 1, blocks: [] },
        partial: null,
        request: { ...assistantRequest(3, 1), turn: 2, completedAt: null, status: 'running' },
      }),
      contribution('tool', 4, {
        kind: 'tool',
        root: {
          kind: 'tool-result',
          seq: 4,
          time: 4,
          callId: 'root',
          call: { name: 'read', argsRaw: '{}' },
          callTime: 3,
          content: [],
          isError: false,
          callView: null,
          resultView: null,
          subCalls: [{
            callId: 'child', name: 'read', argsRaw: '{}', turn: 2, step: 1,
            time: 4, callView: null, subCalls: [],
          }],
        },
      }),
      contribution('tool:missing-call', 5, {
        kind: 'tool',
        root: {
          kind: 'tool-result',
          seq: 5,
          time: 5,
          callId: 'missing',
          call: null,
          callTime: 4,
          content: [],
          isError: false,
          callView: null,
          resultView: null,
          subCalls: [],
        },
      }),
      contribution('turn:missing', 6, {
        kind: 'turn-end', turn: 99, time: 5, error: 'ignored',
      }),
      contribution('turn:error', 7, {
        kind: 'turn-end', turn: 2, time: 7, error: 'failed',
      }),
      contribution('compact:complete', 8, {
        kind: 'compaction',
        request: { ...compactionRequest(7), completedAt: 8, status: 'complete' },
      }),
      contribution('boundary:last', 10, { kind: 'session-end', seq: 10, time: 10 }),
    ] })

    expect(snapshot.eventNodes[0]).toMatchObject({ requestConfig: prompt.config })
    expect(snapshot.eventNodes[1]).toMatchObject({ kind: 'tool-result', callId: 'root' })
    expect(snapshot.eventNodes[2]).toMatchObject({ kind: 'tool-result', callId: 'missing' })
    expect([...snapshot.callSchemas.keys()]).toEqual(['root', 'child'])
    expect(snapshot.requests[0]).toMatchObject({ status: 'error', completedAt: 7 })
    expect(snapshot.requests[1]).toMatchObject({ purpose: 'compaction', status: 'complete' })
  })

  it('constructs and registers the published view definition', () => {
    expect(trajectoryViewDefinition.create()).toBeInstanceOf(TrajectorySnapshotBuilder)
    let registered: unknown
    registerTrajectoryConversationView({
      conversationViews: {
        register(definition: unknown) {
          registered = definition
        },
      },
    } as never)
    expect(registered).toBe(trajectoryViewDefinition)
  })

  it('preserves contribution order when incremental outputs share sequence keys', () => {
    const builder = new TrajectorySnapshotBuilder()
    builder.replace({ nodes: [
      contribution('tool', 1, {
        kind: 'tool',
        root: {
          callId: 'call', name: 'read', argsRaw: '{}', turn: 1, step: 1,
          time: 1, callView: null, subCalls: [],
        },
      }),
      contribution('node', 2, {
        kind: 'node',
        node: { kind: 'assistant', seq: 5, time: 5, turn: 1, step: 1, blocks: [] },
      }),
      contribution('assistant:first', 3, {
        kind: 'assistant', partial: null, request: { ...assistantRequest(10, 1), turn: 1 },
      }),
    ] })

    const finalized = builder.apply({ upserts: [contribution('tool', 1, {
      kind: 'tool',
      root: {
        kind: 'tool-result', seq: 5, time: 5, callId: 'call',
        call: { name: 'read', argsRaw: '{}' }, callTime: 1,
        content: [], isError: false, callView: null, resultView: null, subCalls: [],
      },
    })] })
    expect(finalized.eventNodes.map(node => node.kind)).toEqual(['tool-result', 'assistant'])

    const appended = builder.apply({ upserts: [contribution('assistant:second', 4, {
      kind: 'assistant', partial: null, request: { ...assistantRequest(10, 2), turn: 2 },
    })] })
    expect(appended.requests.map(request => request.purpose === 'assistant' ? request.turn : null))
      .toEqual([1, 2])
  })

  it('uses a full rebuild only when an insertion changes contribution order', () => {
    const operations = operationCounter()
    const builder = new TrajectorySnapshotBuilder(operations.instrumentation)
    builder.replace({ nodes: [contribution('node:2', 2, {
      kind: 'node',
      node: { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 2, blocks: [] },
    })] })
    operations.reset()

    const snapshot = builder.apply({ upserts: [contribution('node:1', 1, {
      kind: 'node',
      node: { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] },
    })] })

    expect(operations.counts).toEqual(new Map([
      ['full-rebuild', 1],
      ['section-rebuild', 5],
      ['contribution-visit', 4],
    ]))
    expect(snapshot.eventNodes.map(node => node.seq)).toEqual([1, 2])
  })
})

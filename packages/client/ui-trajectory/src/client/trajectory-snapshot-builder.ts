import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantMessageNode, ConversationNode, ConversationPromptSnapshot,
  ConversationViewBuilder, ConversationViewDefinition, RequestView,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
  TrajectorySnapshot,
} from './trajectory-contract.ts'
import { reuseArray, reuseMap, reuseValue } from './derived-identity.ts'

const EMPTY_LIST: readonly never[] = []
type AssistantRequest = Extract<RequestView, { purpose: 'assistant' }>
type ToolSchema = ConversationPromptSnapshot['tools'][number]

/** Stable empty target used until a Session has assembled Trajectory records. */
export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  eventNodes: EMPTY_LIST,
  eventLocations: new Map(),
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  partial: null,
  runningCalls: EMPTY_LIST,
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function headerStepKey(header: TrajectoryRequestHeaderState): string | undefined {
  const location = header.location
  return location.kind === 'step'
    ? stepKey(location.turn.turn, location.step.step)
    : undefined
}

function headerFor(
  request: AssistantRequest,
  headersByStep: ReadonlyMap<string, TrajectoryRequestHeaderState>,
  previous: TrajectoryRequestHeaderState | undefined,
): TrajectoryRequestHeaderState | undefined {
  return headersByStep.get(stepKey(request.turn, request.step))
    ?? (previous !== undefined && previous.seq < request.startSeq ? previous : undefined)
}

function applyHeader(
  request: AssistantRequest,
  header: TrajectoryRequestHeaderState | undefined,
  includeChange: boolean,
): AssistantRequest {
  return header === undefined
    ? request
    : {
      ...request,
      prompt: header.prompt,
      requestConfig: header.prompt.config,
      ...(includeChange && header.change !== undefined ? { promptChange: header.change } : {}),
    }
}

function withRequestConfig(
  node: AssistantMessageNode,
  prompt: ConversationPromptSnapshot | undefined,
): AssistantMessageNode {
  return prompt === undefined ? node : { ...node, requestConfig: prompt.config }
}

function captureSchemas(
  block: ToolCallBlock,
  toolsByName: ReadonlyMap<string, ToolSchema>,
  output: Map<string, ToolSchema>,
): void {
  const name = 'kind' in block ? block.call?.name : block.name
  const schema = name === undefined ? undefined : toolsByName.get(name)
  if (schema !== undefined) output.set(block.callId, schema)
  for (const child of block.subCalls) captureSchemas(child, toolsByName, output)
}

function indexTools(tools: readonly ToolSchema[]): ReadonlyMap<string, ToolSchema> {
  return new Map(tools.map(tool => [tool.name, tool]))
}

function interruptCompactions(
  requests: RequestView[],
  boundaries: readonly { seq: number; time: number }[],
): void {
  let nextRequest = 0
  const runningCompactions: number[] = []
  for (const boundary of boundaries) {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest]
      if (request === undefined || request.startSeq >= boundary.seq) break
      if (request.purpose === 'compaction' && request.status === 'running') {
        runningCompactions.push(nextRequest)
      }
      nextRequest++
    }
    let index = runningCompactions.pop()
    /* v8 ignore next -- only running requests enter this private index stack */
    while (index !== undefined && requests[index]?.status !== 'running') {
      index = runningCompactions.pop()
    }
    if (index === undefined) continue
    const request = requests[index]
    /* v8 ignore next -- the stack receives indexes only from the compaction arm above */
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      status: 'error',
      error: 'Compaction was interrupted before completion.',
    }
  }
}

function applyTurnErrors(
  requests: RequestView[],
  endings: readonly { turn: number; time: number; error?: string }[],
): void {
  const lastAssistantByTurn = new Map<number, number>()
  for (const [index, request] of requests.entries()) {
    if (request.purpose === 'assistant') lastAssistantByTurn.set(request.turn, index)
  }
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = lastAssistantByTurn.get(ending.turn)
    if (index === undefined) continue
    const request = requests[index]
    /* v8 ignore next -- the index map receives assistant requests only */
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      status: 'error',
      error: ending.error,
    }
  }
}

/** Deterministic work categories exposed only through builder instrumentation. */
export type TrajectorySnapshotBuilderOperation =
  | 'contribution-visit'
  | 'full-rebuild'
  | 'section-patch'
  | 'section-rebuild'
  | 'tail-append'

/** Test instrumentation for deterministic snapshot-builder operation counts. */
export interface TrajectorySnapshotBuilderInstrumentation {
  /**
   * Observe one unit of builder work.
   *
   * @param operation - Stable operation category performed by the builder.
   */
  onOperation(operation: TrajectorySnapshotBuilderOperation): void
}

const EVENTS = 1 << 0
const REQUESTS = 1 << 1
const SCHEMAS = 1 << 2
const PARTIAL = 1 << 3
const RUNNING_CALLS = 1 << 4
const ALL_SECTIONS = EVENTS | REQUESTS | SCHEMAS | PARTIAL | RUNNING_CALLS

type ProjectionChange = {
  readonly previous: TrajectoryConversationViewNode | undefined
  readonly next: TrajectoryConversationViewNode
  readonly position: number
}

function contributionOrder(
  left: TrajectoryConversationViewNode,
  right: TrajectoryConversationViewNode,
): number {
  return left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key)
}

function equivalent<T>(left: T, right: T): boolean {
  return reuseValue(left, right) === right
}

function changedSections(
  previous: TrajectoryConversationViewNode,
  next: TrajectoryConversationViewNode,
): number {
  const previousData = previous.data
  const nextData = next.data
  if (previousData.kind !== nextData.kind) return ALL_SECTIONS
  if (previousData.kind === 'node' && nextData.kind === 'node') {
    return equivalent(nextData.node, previousData.node)
      && equivalent(next.location, previous.location) ? 0 : EVENTS
  }
  if (previousData.kind === 'assistant' && nextData.kind === 'assistant') {
    return (equivalent(nextData.node, previousData.node) ? 0 : EVENTS)
      | (equivalent(nextData.request, previousData.request) ? 0 : REQUESTS)
      | (equivalent(nextData.partial, previousData.partial) ? 0 : PARTIAL)
  }
  if (previousData.kind === 'tool' && nextData.kind === 'tool') {
    return equivalent(nextData.root, previousData.root)
      ? 0 : EVENTS | SCHEMAS | RUNNING_CALLS
  }
  if (previousData.kind === 'request-header' && nextData.kind === 'request-header') {
    return equivalent(nextData.header, previousData.header)
      ? 0 : EVENTS | REQUESTS | SCHEMAS
  }
  if (previousData.kind === 'compaction' && nextData.kind === 'compaction') {
    return equivalent(nextData.request, previousData.request) ? 0 : REQUESTS
  }
  return equivalent(nextData, previousData) ? 0 : REQUESTS
}

function sectionsForAppend(node: TrajectoryConversationViewNode): number {
  const data = node.data
  if (data.kind === 'node') return EVENTS
  if (data.kind === 'assistant') {
    return (data.node === undefined ? 0 : EVENTS)
      | (data.request === undefined ? 0 : REQUESTS)
      | (data.partial === null ? 0 : PARTIAL)
  }
  if (data.kind === 'tool') return EVENTS | SCHEMAS | RUNNING_CALLS
  if (data.kind === 'request-header') return EVENTS | REQUESTS | SCHEMAS
  return REQUESTS
}

/**
 * Keyed Trajectory snapshot builder with incrementally maintained contribution
 * order and section-level rebuilds. Monotonic appends avoid sorting, while a
 * same-position upsert touches only sections derived from its changed fields.
 */
export class TrajectorySnapshotBuilder implements ConversationViewBuilder<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> {
  private readonly nodes = new Map<string, TrajectoryConversationViewNode>()
  private readonly positions = new Map<string, number>()
  private contributions: TrajectoryConversationViewNode[] = []
  private published: TrajectorySnapshot | null = null
  private eventKeys: string[] = []
  private readonly eventIndexes = new Map<string, number>()
  private requestKeys: string[] = []
  private readonly requestIndexes = new Map<string, number>()
  private runningCallKeys: string[] = []
  private readonly runningCallIndexes = new Map<string, number>()
  private readonly schemaIdsByKey = new Map<string, readonly string[]>()
  private headerPositions: number[] = []
  private readonly headersByStep = new Map<string, TrajectoryRequestHeaderState>()
  private readonly assistantKeysByStep = new Map<string, Set<string>>()
  private readonly consumedPromptHeaderSeqs = new Set<number>()
  readonly empty = EMPTY_TRAJECTORY_SNAPSHOT

  /**
   * Create a builder.
   *
   * @param instrumentation - Optional deterministic operation observer for tests.
   */
  constructor(private readonly instrumentation?: TrajectorySnapshotBuilderInstrumentation) {}

  replace(input: {
    readonly nodes: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    this.rebuildContributions()
    return this.rebuildSections(ALL_SECTIONS)
  }

  apply(input: {
    readonly upserts: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    let sections = 0
    let structural = false
    const projectionChanges: ProjectionChange[] = []

    for (const node of input.upserts) {
      const previous = this.nodes.get(node.key)
      this.nodes.set(node.key, node)
      if (previous === undefined) {
        const last = this.contributions.at(-1)
        if (last !== undefined && contributionOrder(last, node) > 0) {
          structural = true
          continue
        }
        const position = this.contributions.length
        this.positions.set(node.key, position)
        this.contributions.push(node)
        projectionChanges.push({ previous: undefined, next: node, position })
        this.observe('tail-append')
        sections |= sectionsForAppend(node)
        continue
      }
      if (previous.anchorSeq !== node.anchorSeq) {
        structural = true
        continue
      }
      const position = this.positions.get(node.key)
      /* v8 ignore next -- contribution order and its position map update atomically */
      if (position === undefined) {
        structural = true
        continue
      }
      this.contributions[position] = node
      projectionChanges.push({ previous, next: node, position })
      const changed = changedSections(previous, node)
      sections |= changed
    }

    if (structural) {
      this.rebuildContributions()
      return this.rebuildSections(ALL_SECTIONS)
    }
    if (sections === 0) return this.published ?? this.rebuildSections(ALL_SECTIONS)
    const coalescedChanges = new Map<string, ProjectionChange>()
    for (const change of projectionChanges) {
      const existing = coalescedChanges.get(change.next.key)
      coalescedChanges.set(change.next.key, existing === undefined
        ? change
        : { previous: existing.previous, next: change.next, position: change.position })
    }
    const localChanges = [...coalescedChanges.values()]
    if (this.canPatchProjections(localChanges)) {
      return this.patchProjections(localChanges)
    }
    return this.rebuildSections(sections)
  }

  private canPatchProjections(changes: readonly ProjectionChange[]): boolean {
    for (const change of changes) {
      const previousData = change.previous?.data
      const nextData = change.next.data
      if (previousData !== undefined && previousData.kind !== nextData.kind) return false
      if (nextData.kind === 'node' || nextData.kind === 'tool') continue
      if (nextData.kind === 'request-header') {
        if (previousData !== undefined) return false
        continue
      }
      if (nextData.kind !== 'assistant') return false
      const previousAssistant = previousData?.kind === 'assistant' ? previousData : undefined
      if (previousAssistant !== undefined) {
        if ((previousAssistant.request === undefined) !== (nextData.request === undefined)) return false
        if (previousAssistant.request !== undefined && nextData.request !== undefined) {
          const previousHeader = this.headerForPosition(previousAssistant.request, change.position)
          const nextHeader = this.headerForPosition(nextData.request, change.position)
          if (previousHeader !== nextHeader) return false
          const oldRequestIndex = this.requestIndexes.get(change.next.key) as number
          const oldRequest = (this.published as TrajectorySnapshot).requests[oldRequestIndex] as RequestView
          const expectedOldRequest = applyHeader(
            previousAssistant.request,
            previousHeader,
            oldRequest.purpose === 'assistant' && oldRequest.promptChange !== undefined,
          )
          if (!equivalent(oldRequest, expectedOldRequest)) return false
        }
        if (!equivalent(previousAssistant.partial, nextData.partial)
          && (change.position !== this.contributions.length - 1 || nextData.partial === null)) {
          return false
        }
      }
    }
    return true
  }

  private patchProjections(changes: readonly ProjectionChange[]): TrajectorySnapshot {
    const previous = this.published ?? EMPTY_TRAJECTORY_SNAPSHOT
    let eventNodes = previous.eventNodes
    let eventLocations = previous.eventLocations
    let requests = previous.requests
    let callSchemas = previous.callSchemas
    let partial = previous.partial
    let runningCalls = previous.runningCalls

    const effectiveChanges = [...changes]
    const changedKeys = new Set(changes.map(change => change.next.key))
    for (const change of changes) {
      const previousRequest = change.previous?.data.kind === 'assistant'
        ? change.previous.data.request
        : undefined
      if (previousRequest !== undefined) {
        const key = stepKey(previousRequest.turn, previousRequest.step)
        const keys = this.assistantKeysByStep.get(key)
        keys?.delete(change.next.key)
        if (keys?.size === 0) this.assistantKeysByStep.delete(key)
      }
      const nextRequest = change.next.data.kind === 'assistant'
        ? change.next.data.request
        : undefined
      if (nextRequest !== undefined) {
        const key = stepKey(nextRequest.turn, nextRequest.step)
        const keys = this.assistantKeysByStep.get(key) ?? new Set<string>()
        keys.add(change.next.key)
        this.assistantKeysByStep.set(key, keys)
      }
    }
    for (const change of changes) {
      if (change.next.data.kind !== 'request-header') continue
      this.headerPositions.push(change.position)
      const key = headerStepKey(change.next.data.header)
      if (key === undefined) continue
      this.headersByStep.set(key, change.next.data.header)
      for (const assistantKey of this.assistantKeysByStep.get(key) ?? []) {
        if (changedKeys.has(assistantKey)) continue
        const position = this.positions.get(assistantKey)
        const assistant = this.nodes.get(assistantKey)
        /* v8 ignore next -- assistant keys and contribution indexes update atomically */
        if (position === undefined || assistant === undefined) continue
        effectiveChanges.push({ previous: assistant, next: assistant, position })
        changedKeys.add(assistantKey)
      }
    }

    for (const change of effectiveChanges) {
      const nextData = change.next.data
      const oldEventIndex = this.eventIndexes.get(change.next.key)
      const nextEvent = this.eventProjection(change.next, change.position)
      if (oldEventIndex !== undefined || nextEvent !== undefined) {
        const patched = this.patchEventProjection(
          eventNodes,
          eventLocations,
          change,
          oldEventIndex,
          nextEvent,
        )
        eventNodes = patched.eventNodes
        eventLocations = patched.eventLocations
      }

      if (nextData.kind === 'assistant' && nextData.request !== undefined) {
        const header = this.headerForPosition(nextData.request, change.position)
        const oldRequestIndex = this.requestIndexes.get(change.next.key)
        const oldRequest = oldRequestIndex === undefined
          ? undefined
          : previous.requests[oldRequestIndex]
        const includeChange = header?.change !== undefined
          && (this.consumedPromptHeaderSeqs.has(header.seq)
            ? oldRequest?.purpose === 'assistant' && oldRequest.promptChange !== undefined
            : true)
        const request = applyHeader(nextData.request, header, includeChange)
        requests = this.patchRequestProjection(requests, change.next.key, request)
        if (includeChange && header !== undefined) this.consumedPromptHeaderSeqs.add(header.seq)
      }

      if (nextData.kind === 'tool') {
        const running = 'kind' in nextData.root ? undefined : nextData.root
        runningCalls = this.patchRunningProjection(runningCalls, change.next.key, running)
        callSchemas = this.patchSchemaProjection(callSchemas, change.next, change.position)
      }

      if (nextData.kind === 'assistant'
        && nextData.partial !== null
        && change.position === this.contributions.length - 1) {
        partial = nextData.partial
      }
    }

    this.observe('section-patch')
    return this.publish({
      eventNodes,
      eventLocations,
      requests,
      callSchemas,
      partial,
      runningCalls,
    })
  }

  private eventProjection(
    contribution: TrajectoryConversationViewNode,
    position: number,
  ): ConversationNode | undefined {
    const data = contribution.data
    if (data.kind === 'node') return data.node
    if (data.kind === 'assistant' && data.node !== undefined) {
      const header = data.request === undefined
        ? undefined
        : this.headerForPosition(data.request, position)
      return withRequestConfig(data.node, header?.prompt)
    }
    return data.kind === 'tool' && 'kind' in data.root ? data.root : undefined
  }

  private patchEventProjection(
    sourceNodes: readonly ConversationNode[],
    sourceLocations: ReadonlyMap<number, TrajectoryConversationViewNode['location']>,
    change: ProjectionChange,
    oldIndex: number | undefined,
    nextEvent: ConversationNode | undefined,
  ): {
    readonly eventNodes: readonly ConversationNode[]
    readonly eventLocations: ReadonlyMap<number, TrajectoryConversationViewNode['location']>
  } {
    const nodes = [...sourceNodes]
    const locations = new Map(sourceLocations)
    const oldNode = oldIndex === undefined ? undefined : nodes[oldIndex]
    if (oldIndex !== undefined && oldNode !== undefined && nextEvent !== undefined
      && oldNode.seq === nextEvent.seq) {
      nodes[oldIndex] = nextEvent
      if (change.previous?.data.kind === 'node') locations.delete(oldNode.seq)
      if (change.next.data.kind === 'node') locations.set(nextEvent.seq, change.next.location)
      return { eventNodes: nodes, eventLocations: locations }
    }
    if (oldIndex !== undefined) {
      nodes.splice(oldIndex, 1)
      this.eventKeys.splice(oldIndex, 1)
      if (change.previous?.data.kind === 'node' && oldNode !== undefined) locations.delete(oldNode.seq)
    }
    if (nextEvent !== undefined) {
      let low = 0
      let high = nodes.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const middleSeq = (nodes[middle] as ConversationNode).seq
        const middlePosition = this.positions.get(this.eventKeys[middle] as string) as number
        if (middleSeq < nextEvent.seq
          || (middleSeq === nextEvent.seq && middlePosition <= change.position)) low = middle + 1
        else high = middle
      }
      nodes.splice(low, 0, nextEvent)
      this.eventKeys.splice(low, 0, change.next.key)
      if (change.next.data.kind === 'node') locations.set(nextEvent.seq, change.next.location)
    }
    this.reindex(this.eventKeys, this.eventIndexes)
    return { eventNodes: nodes, eventLocations: locations }
  }

  private patchRequestProjection(
    source: readonly RequestView[],
    key: string,
    next: RequestView,
  ): readonly RequestView[] {
    const requests = [...source]
    const oldIndex = this.requestIndexes.get(key)
    if (oldIndex !== undefined && requests[oldIndex]?.startSeq === next.startSeq) {
      requests[oldIndex] = next
      return requests
    }
    if (oldIndex !== undefined) {
      requests.splice(oldIndex, 1)
      this.requestKeys.splice(oldIndex, 1)
    }
    let low = 0
    let high = requests.length
    const position = this.positions.get(key) as number
    while (low < high) {
      const middle = (low + high) >>> 1
      const middleStart = (requests[middle] as RequestView).startSeq
      const middlePosition = this.positions.get(this.requestKeys[middle] as string) as number
      if (middleStart < next.startSeq
        || (middleStart === next.startSeq && middlePosition <= position)) low = middle + 1
      else high = middle
    }
    requests.splice(low, 0, next)
    this.requestKeys.splice(low, 0, key)
    this.reindex(this.requestKeys, this.requestIndexes)
    return requests
  }

  private patchRunningProjection(
    source: TrajectorySnapshot['runningCalls'],
    key: string,
    next: TrajectorySnapshot['runningCalls'][number] | undefined,
  ): TrajectorySnapshot['runningCalls'] {
    const calls = [...source]
    const oldIndex = this.runningCallIndexes.get(key)
    if (oldIndex !== undefined && next !== undefined) {
      calls[oldIndex] = next
      return calls
    }
    if (oldIndex !== undefined) {
      calls.splice(oldIndex, 1)
      this.runningCallKeys.splice(oldIndex, 1)
    }
    if (next !== undefined) {
      const position = this.positions.get(key) as number
      let low = 0
      let high = this.runningCallKeys.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const middlePosition = this.positions.get(this.runningCallKeys[middle] as string) as number
        if (middlePosition < position) low = middle + 1
        else high = middle
      }
      calls.splice(low, 0, next)
      this.runningCallKeys.splice(low, 0, key)
    }
    this.reindex(this.runningCallKeys, this.runningCallIndexes)
    return calls
  }

  private patchSchemaProjection(
    source: ReadonlyMap<string, ToolSchema>,
    contribution: TrajectoryConversationViewNode,
    position: number,
  ): ReadonlyMap<string, ToolSchema> {
    const schemas = new Map(source)
    for (const callId of this.schemaIdsByKey.get(contribution.key) ?? []) schemas.delete(callId)
    const nextIds: string[] = []
    const data = contribution.data
    const header = this.previousHeader(position)
    if (data.kind === 'tool' && header !== undefined && header.seq < contribution.anchorSeq) {
      const captured = new Map<string, ToolSchema>()
      captureSchemas(data.root, indexTools(header.prompt.tools), captured)
      for (const [callId, schema] of captured) {
        schemas.set(callId, schema)
        nextIds.push(callId)
      }
    }
    this.schemaIdsByKey.set(contribution.key, nextIds)
    return schemas
  }

  private headerForPosition(
    request: AssistantRequest,
    position: number,
  ): TrajectoryRequestHeaderState | undefined {
    return headerFor(request, this.headersByStep, this.previousHeader(position))
  }

  private previousHeader(position: number): TrajectoryRequestHeaderState | undefined {
    let low = 0
    let high = this.headerPositions.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((this.headerPositions[middle] as number) < position) low = middle + 1
      else high = middle
    }
    const headerPosition = this.headerPositions[low - 1]
    if (headerPosition === undefined) return undefined
    const contribution = this.contributions[headerPosition]
    /* v8 ignore next -- header positions contain request-header contributions only */
    return contribution?.data.kind === 'request-header' ? contribution.data.header : undefined
  }

  private reindex(keys: readonly string[], output: Map<string, number>): void {
    output.clear()
    for (const [index, key] of keys.entries()) output.set(key, index)
  }

  private rebuildSections(sections: number): TrajectorySnapshot {
    for (const section of [EVENTS, REQUESTS, SCHEMAS, PARTIAL, RUNNING_CALLS]) {
      if ((sections & section) !== 0) this.observe('section-rebuild')
    }
    const previous = this.published ?? EMPTY_TRAJECTORY_SNAPSHOT
    const needsHeadersByStep = (sections & (EVENTS | REQUESTS)) !== 0
    const headersByStep = new Map<string, TrajectoryRequestHeaderState>()
    if (needsHeadersByStep) {
      for (const contribution of this.contributions) {
        this.observe('contribution-visit')
        if (contribution.data.kind !== 'request-header') continue
        const key = headerStepKey(contribution.data.header)
        if (key !== undefined) headersByStep.set(key, contribution.data.header)
      }
    }

    const finalized: ConversationNode[] = []
    const eventLocations = new Map<number, TrajectoryConversationViewNode['location']>()
    const requests: RequestView[] = []
    const boundaries: { seq: number; time: number }[] = []
    const turnEndings: { turn: number; time: number; error?: string }[] = []
    const callSchemas = new Map<string, ToolSchema>()
    const consumedPromptChanges = new Set<number>()
    let previousHeader: TrajectoryRequestHeaderState | undefined
    let previousTools: ReadonlyMap<string, ToolSchema> = new Map()
    let partial: TrajectorySnapshot['partial'] = null
    const runningCalls: TrajectorySnapshot['runningCalls'][number][] = []

    for (const contribution of this.contributions) {
      this.observe('contribution-visit')
      const data = contribution.data
      if (data.kind === 'request-header') {
        previousHeader = data.header
        if ((sections & SCHEMAS) !== 0) previousTools = indexTools(data.header.prompt.tools)
        continue
      }
      if (data.kind === 'node') {
        if ((sections & EVENTS) !== 0) {
          finalized.push(data.node)
          eventLocations.set(data.node.seq, contribution.location)
        }
        continue
      }
      if (data.kind === 'assistant') {
        const header = (sections & (EVENTS | REQUESTS)) !== 0 && data.request !== undefined
          ? headerFor(data.request, headersByStep, previousHeader)
          : undefined
        if ((sections & EVENTS) !== 0 && data.node !== undefined) {
          finalized.push(withRequestConfig(data.node, header?.prompt))
        }
        if ((sections & PARTIAL) !== 0 && data.partial !== null) partial = data.partial
        if ((sections & REQUESTS) !== 0 && data.request !== undefined) {
          const includeChange = header?.change !== undefined
            && !consumedPromptChanges.has(header.seq)
          requests.push(applyHeader(data.request, header, includeChange))
          if (includeChange) consumedPromptChanges.add(header.seq)
        }
        continue
      }
      if (data.kind === 'tool') {
        if ((sections & EVENTS) !== 0 && 'kind' in data.root) finalized.push(data.root)
        if ((sections & RUNNING_CALLS) !== 0 && !('kind' in data.root)) runningCalls.push(data.root)
        if ((sections & SCHEMAS) !== 0
          && previousHeader !== undefined
          && previousHeader.seq < contribution.anchorSeq) {
          captureSchemas(data.root, previousTools, callSchemas)
        }
        continue
      }
      if (data.kind === 'compaction') {
        if ((sections & REQUESTS) !== 0) requests.push(data.request)
        continue
      }
      if (data.kind === 'session-end') {
        if ((sections & REQUESTS) !== 0) boundaries.push({ seq: data.seq, time: data.time })
        continue
      }
      if ((sections & REQUESTS) !== 0) {
        turnEndings.push({
          turn: data.turn,
          time: data.time,
          ...(data.error === undefined ? {} : { error: data.error }),
        })
      }
    }

    if ((sections & REQUESTS) !== 0) {
      requests.sort((left, right) => left.startSeq - right.startSeq)
      interruptCompactions(requests, boundaries)
      applyTurnErrors(requests, turnEndings)
    }
    if ((sections & EVENTS) !== 0) finalized.sort((left, right) => left.seq - right.seq)
    const snapshot = this.publish({
      eventNodes: (sections & EVENTS) === 0 ? previous.eventNodes : finalized,
      eventLocations: (sections & EVENTS) === 0 ? previous.eventLocations : eventLocations,
      requests: (sections & REQUESTS) === 0 ? previous.requests : requests,
      callSchemas: (sections & SCHEMAS) === 0 ? previous.callSchemas : callSchemas,
      partial: (sections & PARTIAL) === 0 ? previous.partial : partial,
      runningCalls: (sections & RUNNING_CALLS) === 0 ? previous.runningCalls : runningCalls,
    })
    this.rebuildProjectionIndexes()
    return snapshot
  }

  private rebuildProjectionIndexes(): void {
    this.headerPositions = []
    this.headersByStep.clear()
    this.assistantKeysByStep.clear()
    this.consumedPromptHeaderSeqs.clear()
    this.schemaIdsByKey.clear()
    const eventRecords: { key: string; seq: number }[] = []
    const requestRecords: { key: string; startSeq: number }[] = []
    const runningKeys: string[] = []

    for (const [position, contribution] of this.contributions.entries()) {
      if (contribution.data.kind !== 'request-header') continue
      this.headerPositions.push(position)
      const key = headerStepKey(contribution.data.header)
      if (key !== undefined) this.headersByStep.set(key, contribution.data.header)
    }

    let previousHeader: TrajectoryRequestHeaderState | undefined
    let previousTools: ReadonlyMap<string, ToolSchema> = new Map()
    for (const [position, contribution] of this.contributions.entries()) {
      const data = contribution.data
      if (data.kind === 'request-header') {
        previousHeader = data.header
        previousTools = indexTools(data.header.prompt.tools)
        continue
      }
      if (data.kind === 'node') {
        eventRecords.push({ key: contribution.key, seq: data.node.seq })
        continue
      }
      if (data.kind === 'assistant') {
        if (data.request !== undefined) {
          const key = stepKey(data.request.turn, data.request.step)
          const keys = this.assistantKeysByStep.get(key) ?? new Set<string>()
          keys.add(contribution.key)
          this.assistantKeysByStep.set(key, keys)
        }
        const header = data.request === undefined
          ? undefined
          : headerFor(data.request, this.headersByStep, previousHeader)
        if (data.node !== undefined) eventRecords.push({ key: contribution.key, seq: data.node.seq })
        if (data.request !== undefined) {
          requestRecords.push({ key: contribution.key, startSeq: data.request.startSeq })
          if (header?.change !== undefined) this.consumedPromptHeaderSeqs.add(header.seq)
        }
        continue
      }
      if (data.kind === 'tool') {
        if ('kind' in data.root) eventRecords.push({ key: contribution.key, seq: data.root.seq })
        else runningKeys.push(contribution.key)
        const ids: string[] = []
        if (previousHeader !== undefined && previousHeader.seq < contribution.anchorSeq) {
          const captured = new Map<string, ToolSchema>()
          captureSchemas(data.root, previousTools, captured)
          ids.push(...captured.keys())
        }
        this.schemaIdsByKey.set(contribution.key, ids)
        continue
      }
      if (data.kind === 'compaction') {
        requestRecords.push({ key: contribution.key, startSeq: data.request.startSeq })
      }
      void position
    }

    eventRecords.sort((left, right) => left.seq - right.seq)
    requestRecords.sort((left, right) => left.startSeq - right.startSeq)
    this.eventKeys = eventRecords.map(record => record.key)
    this.requestKeys = requestRecords.map(record => record.key)
    this.runningCallKeys = runningKeys
    this.reindex(this.eventKeys, this.eventIndexes)
    this.reindex(this.requestKeys, this.requestIndexes)
    this.reindex(this.runningCallKeys, this.runningCallIndexes)
  }

  private publish(next: TrajectorySnapshot): TrajectorySnapshot {
    const previous = this.published
    if (previous === null) {
      this.published = next
      return next
    }
    const folded: TrajectorySnapshot = {
      eventNodes: next.eventNodes === previous.eventNodes
        ? previous.eventNodes
        : reuseArray(next.eventNodes as ConversationNode[], previous.eventNodes),
      eventLocations: next.eventLocations === previous.eventLocations
        ? previous.eventLocations
        : reuseMap(
          next.eventLocations as Map<number, TrajectoryConversationViewNode['location']>,
          previous.eventLocations,
        ),
      requests: next.requests === previous.requests
        ? previous.requests
        : reuseArray(next.requests as RequestView[], previous.requests),
      callSchemas: next.callSchemas === previous.callSchemas
        ? previous.callSchemas
        : reuseMap(next.callSchemas as Map<string, ToolSchema>, previous.callSchemas),
      partial: next.partial === null
        ? null
        : reuseValue(next.partial, previous.partial ?? undefined),
      runningCalls: next.runningCalls === previous.runningCalls
        ? previous.runningCalls
        : reuseArray(
          next.runningCalls as TrajectorySnapshot['runningCalls'][number][],
          previous.runningCalls,
        ),
    }
    const snapshot = folded.eventNodes === previous.eventNodes
      && folded.eventLocations === previous.eventLocations
      && folded.requests === previous.requests
      && folded.callSchemas === previous.callSchemas
      && folded.partial === previous.partial
      && folded.runningCalls === previous.runningCalls
      ? previous
      : folded
    this.published = snapshot
    return snapshot
  }

  private rebuildContributions(): void {
    this.observe('full-rebuild')
    this.contributions = [...this.nodes.values()].sort(contributionOrder)
    this.positions.clear()
    for (const [index, contribution] of this.contributions.entries()) {
      this.positions.set(contribution.key, index)
    }
  }

  private observe(operation: TrajectorySnapshotBuilderOperation): void {
    this.instrumentation?.onOperation(operation)
  }
}

/** Trajectory target factory preserving the existing stage-oriented view model. */
export const trajectoryViewDefinition: ConversationViewDefinition<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> = {
  target: 'trajectory',
  create: () => new TrajectorySnapshotBuilder(),
}

/**
 * Register the stage-oriented Trajectory target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerTrajectoryConversationView(ctx: Context): void {
  ctx.conversationViews.register(trajectoryViewDefinition)
}

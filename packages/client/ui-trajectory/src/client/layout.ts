/**
 * Trajectory list fold: expand assistant blocks, attach usage to Message,
 * own-duration times, in-flight partial/runningCalls, and group descriptions.
 */
import type {
  AssistantBlock,
  AssistantMessageNode,
  ConversationLocation,
  ConversationPromptSnapshot,
  ConversationSnapshot,
  RequestInspectionSnapshot,
  RequestPromptChange,
  RequestView,
  ToolCallBlock,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryCellProps,
  TrajectorySourceBlock,
} from './trajectory-record.ts'
import { formatElapsedSeconds } from './trajectory-record.ts'

/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
  turn: number | null
  groups: readonly TrajectoryGroupModel[]
}

/** Snapshot slice the trajectory view folds. */
export interface TrajectoryLayoutInput {
  nodes: ConversationSnapshot['nodes']
  eventLocations?: ReadonlyMap<number, ConversationLocation>
  partial: ConversationSnapshot['partial']
  runningCalls: ConversationSnapshot['runningCalls']
  requests?: readonly RequestView[]
  callSchemas?: RequestInspectionSnapshot['callSchemas']
}

const EMPTY_DEPS: readonly unknown[] = []
const EMPTY_CALL_IDS: ReadonlySet<string> = new Set()

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/** Cell plus absolute ms for group wall-span descriptions. */
interface LaidCell {
  cell: TrajectoryCellProps
  absTime: number | null
  toolName?: string
  callId?: string
  subCalls?: readonly ToolCallBlock[]
}

interface LaidGroup {
  title: string
  laid: LaidCell[]
}

interface TurnBucket {
  groups: LaidGroup[]
  /** Step groups by title, so a step's later contributions do not rescan the turn. */
  stepGroups: Map<string, LaidGroup>
}

type ToolSchema = ConversationPromptSnapshot['tools'][number]

/** One memoized expansion: the cells a single input produced, plus what they read. */
interface LaidRecord {
  startIndex: number
  deps: readonly unknown[]
  /** Tool schema attached to each produced cell, aligned to `laid`. */
  schemas: readonly (ToolSchema | undefined)[]
  laid: LaidCell[]
}

/**
 * The node-derived indexes of one derivation, extended in place when the next
 * derivation's `nodes` array starts with exactly the same members.
 */
interface NodeIndexRecord {
  nodes: ConversationSnapshot['nodes']
  /** `kind: 'node'` layout entries, one per node, in `nodes` order. */
  entries: OrderedLayoutEntry[]
  /** True while `nodes` is ordered by `seq`, which lets entries merge instead of sort. */
  ordered: boolean
  results: Map<string, ToolResultNode>
  callStarts: Map<string, number>
  emittedCallIds: Set<string>
  /** Next assistant node at a higher index, per node index. */
  following: (AssistantMessageNode | undefined)[]
  /** `turn\0step` keys already carrying an assistant node. */
  represented: Set<string>
}

/** One memoized turn: the buckets it was built from, and the model they produced. */
interface TurnRecord {
  groups: readonly LaidGroup[]
  model: TrajectoryTurnModel
}

/**
 * Per-view memo that makes an append extend the previous layout instead of
 * rebuilding it.
 *
 * The fold stays whole — every derivation still walks every entry — but the
 * expensive per-record expansion, the per-turn model, and the result array are
 * reused whenever the inputs they read did not move. A cache is therefore
 * never load-bearing for correctness: dropping it changes identities only, and
 * {@link deriveTrajectoryLayout} without one is the reference path the
 * equivalence tests compare against.
 *
 * One cache belongs to one view: it holds that view's previous derivation.
 */
export interface TrajectoryLayoutCache {
  /** Expansions keyed by the input record that produced them. */
  readonly laid: WeakMap<object, LaidRecord>
  /** Serialized tool schemas keyed by the schema object. */
  readonly schemaText: WeakMap<object, string>
  /** Previous derivation's node-derived indexes. */
  nodeIndexes: NodeIndexRecord | undefined
  /** Previous derivation's turn models, keyed by turn identity. */
  turns: Map<string, TurnRecord>
  /** Previous derivation's result array. */
  result: readonly TrajectoryTurnModel[] | undefined
}

/**
 * Create the memo one trajectory view passes to every derivation it makes.
 *
 * @returns An empty cache; pass the same one on each derivation of that view.
 */
export function createTrajectoryLayoutCache(): TrajectoryLayoutCache {
  return {
    laid: new WeakMap(),
    schemaText: new WeakMap(),
    nodeIndexes: undefined,
    turns: new Map(),
    result: undefined,
  }
}

/** Assign each node index the next assistant above it, and backfill the shorter prefix. */
function extendFollowing(
  following: (AssistantMessageNode | undefined)[],
  nodes: ConversationSnapshot['nodes'],
  from: number,
): void {
  let assistant: AssistantMessageNode | undefined
  for (let index = nodes.length - 1; index >= from; index--) {
    following[index] = assistant
    const node = nodes[index]
    if (node?.kind === 'assistant') assistant = node
  }
  if (assistant === undefined) return
  for (let index = from - 1; index >= 0 && following[index] === undefined; index--) {
    following[index] = assistant
  }
}

/** Fold `nodes[from..]` into the record's indexes. */
function extendNodeIndexes(record: NodeIndexRecord, nodes: ConversationSnapshot['nodes'], from: number): void {
  for (let index = from; index < nodes.length; index++) {
    const node = nodes[index]
    if (node === undefined) continue
    const previous = record.entries.at(-1)
    if (previous !== undefined && node.seq < previous.seq) record.ordered = false
    record.entries.push({ kind: 'node', seq: node.seq, node, nodeIndex: index })
    if (node.kind === 'tool-result') {
      record.results.set(node.callId, node)
      const startedAt = finiteTime(node.callTime)
      if (startedAt !== null) record.callStarts.set(node.callId, startedAt)
      continue
    }
    if (node.kind !== 'assistant') continue
    for (const block of node.blocks) {
      if (block.kind === 'tool-call') record.emittedCallIds.add(block.callId)
    }
    if (node.step > 0) record.represented.add(stepKey(node.turn, node.step))
  }
  extendFollowing(record.following, nodes, from)
  record.nodes = nodes
}

/**
 * Reuse the previous derivation's node-derived indexes, extending them when
 * the new `nodes` array only appended members, and rebuilding otherwise.
 */
function nodeIndexesFor(
  cache: TrajectoryLayoutCache | undefined,
  nodes: ConversationSnapshot['nodes'],
): NodeIndexRecord {
  const cached = cache?.nodeIndexes
  if (cached !== undefined && nodes.length >= cached.nodes.length) {
    let shared = true
    for (let index = 0; index < cached.nodes.length; index++) {
      if (cached.nodes[index] !== nodes[index]) {
        shared = false
        break
      }
    }
    if (shared) {
      extendNodeIndexes(cached, nodes, cached.nodes.length)
      return cached
    }
  }
  const record: NodeIndexRecord = {
    nodes: [],
    entries: [],
    ordered: true,
    results: new Map(),
    callStarts: new Map(),
    emittedCallIds: new Set(),
    following: [],
    represented: new Set(),
  }
  extendNodeIndexes(record, nodes, 0)
  if (cache !== undefined) cache.nodeIndexes = record
  return record
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

/** Merge the node entries with the request-derived entries, both already ordered. */
function mergeLayoutEntries(
  nodeEntries: readonly OrderedLayoutEntry[],
  requestEntries: readonly OrderedLayoutEntry[],
): OrderedLayoutEntry[] {
  const merged: OrderedLayoutEntry[] = []
  let left = 0
  let right = 0
  while (left < nodeEntries.length && right < requestEntries.length) {
    const nodeEntry = nodeEntries[left] as OrderedLayoutEntry
    const requestEntry = requestEntries[right] as OrderedLayoutEntry
    if (layoutEntryOrder(nodeEntry) <= layoutEntryOrder(requestEntry)) {
      merged.push(nodeEntry)
      left++
      continue
    }
    merged.push(requestEntry)
    right++
  }
  for (; left < nodeEntries.length; left++) merged.push(nodeEntries[left] as OrderedLayoutEntry)
  for (; right < requestEntries.length; right++) {
    merged.push(requestEntries[right] as OrderedLayoutEntry)
  }
  return merged
}

function schemaDetailText(schema: ToolSchema, cache: TrajectoryLayoutCache | undefined): string {
  const cached = cache?.schemaText.get(schema)
  if (cached !== undefined) return cached
  const text = JSON.stringify(schema, null, 2)
  cache?.schemaText.set(schema, text)
  return text
}

/** Attach each cell's tool schema and report the schema every cell read. */
function attachSchemas(
  laid: readonly LaidCell[],
  callSchemas: TrajectoryLayoutInput['callSchemas'],
  cache: TrajectoryLayoutCache | undefined,
): readonly (ToolSchema | undefined)[] {
  const schemas: (ToolSchema | undefined)[] = []
  for (const entry of laid) {
    const schema = entry.callId === undefined ? undefined : callSchemas?.get(entry.callId)
    schemas.push(schema)
    if (schema !== undefined) entry.cell.schemaDetail = schemaDetailText(schema, cache)
  }
  return schemas
}

function sameDeps(cached: readonly unknown[], deps: readonly unknown[]): boolean {
  if (cached.length !== deps.length) return false
  for (const [index, value] of deps.entries()) {
    if (cached[index] !== value) return false
  }
  return true
}

function sameSchemas(
  record: LaidRecord,
  callSchemas: TrajectoryLayoutInput['callSchemas'],
): boolean {
  for (const [index, entry] of record.laid.entries()) {
    const schema = entry.callId === undefined ? undefined : callSchemas?.get(entry.callId)
    if (record.schemas[index] !== schema) return false
  }
  return true
}

/**
 * Reuse the cells one input produced last time, or expand it again.
 *
 * The cells are shared with the previous derivation's result, so nothing may
 * mutate them afterwards; every value a producer reads outside `key` must
 * appear in `deps`, or a stale expansion survives an input change.
 */
function laidFor(
  cache: TrajectoryLayoutCache | undefined,
  key: object,
  startIndex: number,
  deps: readonly unknown[],
  callSchemas: TrajectoryLayoutInput['callSchemas'],
  produce: () => LaidCell[],
): LaidCell[] {
  const cached = cache?.laid.get(key)
  if (
    cached !== undefined
    && cached.startIndex === startIndex
    && sameDeps(cached.deps, deps)
    && sameSchemas(cached, callSchemas)
  ) return cached.laid
  const laid = produce()
  const schemas = attachSchemas(laid, callSchemas, cache)
  cache?.laid.set(key, { startIndex, deps, schemas, laid })
  return laid
}

function sameBucket(record: TurnRecord, groups: readonly LaidGroup[]): boolean {
  if (record.groups.length !== groups.length) return false
  for (const [index, group] of groups.entries()) {
    const cached = record.groups[index]
    if (cached === undefined || cached.title !== group.title) return false
    if (cached.laid.length !== group.laid.length) return false
    for (const [position, entry] of group.laid.entries()) {
      if (cached.laid[position] !== entry) return false
    }
  }
  return true
}

/** Reuse the turn model whose groups hold exactly the same cells as last time. */
function turnModelFor(
  cache: TrajectoryLayoutCache | undefined,
  turns: Map<string, TurnRecord>,
  key: string,
  turn: number | null,
  entry: TurnBucket,
): TrajectoryTurnModel {
  const cached = cache?.turns.get(key)
  const model = cached !== undefined && sameBucket(cached, entry.groups)
    ? cached.model
    : toTurnModel(turn, entry)
  turns.set(key, { groups: entry.groups, model })
  return model
}

type AssistantRequestView = Extract<RequestView, { purpose: 'assistant' }>
type CompactionRequestView = Extract<RequestView, { purpose: 'compaction' }>

type InputNode = Extract<
  ConversationSnapshot['nodes'][number],
  { kind: 'user' | 'steering' | 'context' }
>

type OrderedLayoutEntry =
  | {
    kind: 'node'
    seq: number
    node: ConversationSnapshot['nodes'][number]
    nodeIndex: number
  }
  | {
    kind: 'compaction'
    seq: number
    request: CompactionRequestView
  }
  | {
    kind: 'system'
    seq: number
    request: AssistantRequestView
    change: RequestPromptChange
  }
  | {
    kind: 'request'
    seq: number
    request: AssistantRequestView
  }

function layoutEntryOrder(entry: OrderedLayoutEntry): number {
  return entry.kind === 'system' && entry.change.kind === 'initial'
    ? Number.NEGATIVE_INFINITY
    : entry.seq
}

function inputCellDetail(node: InputNode): Pick<
  TrajectoryCellProps,
  | 'text'
  | 'previewMarkdown'
  | 'sourceSeq'
  | 'messageSource'
  | 'inputDetail'
  | 'sourceBlocks'
  | 'timeSeconds'
  | 'startedAt'
> {
  const previewMarkdown = previewContent(node.content)
  return {
    text: '',
    ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
    sourceSeq: node.seq,
    messageSource: node.source,
    inputDetail: detailContent(node.content),
    sourceBlocks: node.content.map(block => sourceBlock(block)),
    timeSeconds: 0,
    startedAt: finiteTime(node.time),
  }
}

/**
 * Fold a snapshot into turn → Message/Step groups with expanded cells.
 * @param input - nodes plus in-flight partial/runningCalls.
 * @param cache - Optional per-view memo from {@link createTrajectoryLayoutCache}.
 *   With one, a record whose inputs did not move keeps its previously expanded
 *   cells and its turn keeps its model, so appending one event costs the tail
 *   rather than the session. Without one, every record is expanded again; the
 *   two paths produce equal content and differ only in identity.
 * @returns turns ordered by first appearance.
 */
export function deriveTrajectoryLayout(
  input: TrajectoryLayoutInput,
  cache?: TrajectoryLayoutCache,
): readonly TrajectoryTurnModel[] {
  const {
    nodes, eventLocations, partial, runningCalls, requests = [], callSchemas,
  } = input
  const indexes = nodeIndexesFor(cache, nodes)
  const resultByCall = indexes.results
  const emittedCallIds = indexes.emittedCallIds
  const followingAssistants = indexes.following
  let callById: ReadonlyMap<string, ToolCallBlock> = resultByCall
  let callStartById: ReadonlyMap<string, number> = indexes.callStarts
  if (runningCalls.length > 0) {
    const calls = new Map<string, ToolCallBlock>(resultByCall)
    const starts = new Map<string, number>(indexes.callStarts)
    for (const call of runningCalls) {
      calls.set(call.callId, call)
      const startedAt = finiteTime(call.time)
      if (startedAt !== null) starts.set(call.callId, startedAt)
    }
    callById = calls
    callStartById = starts
  }
  const turns = new Map<number, TurnBucket>()
  const standaloneCompactions: TurnBucket[] = []
  let index = 0
  let prevAbsTime: number | null = null
  let lastAssistantTurn: number | null = null

  const bucket = (turn: number) => {
    let entry = turns.get(turn)
    if (entry === undefined) {
      entry = { groups: [], stepGroups: new Map() }
      turns.set(turn, entry)
    }
    return entry
  }

  const pushMessage = (turn: number, laid: LaidCell) => {
    const groups = bucket(turn).groups
    const last = groups.at(-1)
    if (last?.title === 'Message') {
      last.laid.push(laid)
      return
    }
    groups.push({ title: 'Message', laid: [laid] })
  }
  const openStep = (turn: number, step: number) => {
    const entry = bucket(turn)
    const title = `Step ${step}`
    return { entry, title, existing: entry.stepGroups.get(title) }
  }
  const pushStep = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const { entry, title, existing } = openStep(turn, step)
    if (existing !== undefined) {
      existing.laid.push(...laid)
      return
    }
    const group = { title, laid: [...laid] }
    entry.groups.push(group)
    entry.stepGroups.set(title, group)
  }
  const pushStepInput = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const { entry, title, existing } = openStep(turn, step)
    if (existing === undefined) {
      const group = { title, laid: [...laid] }
      entry.groups.push(group)
      entry.stepGroups.set(title, group)
      return
    }
    const request = existing.laid.findIndex(entry => entry.cell.requestOnly === true)
    if (request === -1) existing.laid.push(...laid)
    else existing.laid.splice(request, 0, ...laid)
  }

  const liveRepresented = new Set<string>()
  if (partial !== null && partial.step > 0) {
    liveRepresented.add(stepKey(partial.turn, partial.step))
  }
  for (const call of runningCalls) {
    if (call.step > 0) liveRepresented.add(stepKey(call.turn, call.step))
  }
  const isRepresented = (turn: number, step: number): boolean => {
    const key = stepKey(turn, step)
    return indexes.represented.has(key) || liveRepresented.has(key)
  }

  const requestEntries: OrderedLayoutEntry[] = [
    ...requests
      .filter((request): request is CompactionRequestView =>
        request.purpose === 'compaction')
      .map(request => ({
        kind: 'compaction' as const,
        seq: request.startSeq,
        request,
      })),
    ...requests.flatMap(request => request.purpose !== 'assistant'
      || request.promptChange === undefined
      || request.prompt === undefined
      ? []
      : [{
        kind: 'system' as const,
        seq: request.promptChange.seq,
        request,
        change: request.promptChange,
      }]),
    ...requests
      .filter((request): request is AssistantRequestView =>
        request.purpose === 'assistant')
      .filter(request => !isRepresented(request.turn, request.step))
      .map(request => ({
        kind: 'request' as const,
        seq: request.startSeq,
        request,
      })),
  ].sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right))
  const entries: readonly OrderedLayoutEntry[] = requestEntries.length === 0
    ? indexes.entries
    : indexes.ordered
      ? mergeLayoutEntries(indexes.entries, requestEntries)
      : [...indexes.entries, ...requestEntries]
        .sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right))

  for (const entry of entries) {
    if (entry.kind === 'request') {
      const { request } = entry
      const laid = laidFor(cache, request, index + 1, EMPTY_DEPS, callSchemas, () => [{
        absTime: finiteTime(request.startedAt),
        cell: {
          index: index + 1,
          kind: 'message',
          text: '',
          sourceSeq: request.startSeq,
          requestOnly: true,
          timeSeconds: request.completedAt === null
            ? null
            : durationSeconds(request.completedAt, request.startedAt),
          startedAt: finiteTime(request.startedAt),
          ...(request.status === 'error' ? { isError: true } : {}),
        },
      }])
      index += laid.length
      pushStep(request.turn, request.step, laid)
      prevAbsTime = finiteTime(request.completedAt)
        ?? finiteTime(request.startedAt)
        ?? prevAbsTime
      continue
    }
    if (entry.kind === 'system') {
      const { change, request } = entry
      const turn = change.kind === 'initial'
        ? firstVisibleTurn(nodes, partial)
        : enclosingPromptTurn(nodes, change.seq, partial)
      const laid = laidFor(cache, change, index + 1, [request], callSchemas, () => [{
        absTime: finiteTime(change.time),
        cell: {
          index: index + 1,
          kind: 'system',
          text: promptChangeLabel(change),
          sourceSeq: change.seq,
          ...(request.prompt === undefined ? {} : { promptDetail: request.prompt }),
          ...(change.previous === undefined
            ? {}
            : { previousPromptDetail: change.previous }),
          timeSeconds: 0,
          startedAt: finiteTime(change.time),
        },
      }])
      index += laid.length
      for (const cell of laid) pushMessage(turn, cell)
      prevAbsTime = finiteTime(change.time) ?? prevAbsTime
      continue
    }
    if (entry.kind === 'compaction') {
      const request = entry.request
      const laid = laidFor(cache, request, index + 1, EMPTY_DEPS, callSchemas, () => {
        const rawOutput = request.rawOutput ?? request.summary
        const thinkingDetail = rawOutput === undefined
          ? ''
          : detailReasoning(rawOutput)
        const cell: TrajectoryCellProps = {
          index: index + 1,
          kind: 'compacted',
          text: request.status === 'running'
            ? 'Compacting context…'
            : request.status === 'error'
              ? request.error ?? 'Compaction failed'
              : request.summary === undefined
                ? 'Context compacted'
                : '',
          ...(request.status === 'complete' && request.summary !== undefined
            ? previewContentProperty(request.summary)
            : {}),
          sourceSeq: request.startSeq,
          ...(request.summary === undefined
            ? {}
            : {
              outputDetail: detailContent(request.summary),
              outputBlocks: request.summary.map(block => sourceBlock(block)),
            }),
          ...(thinkingDetail === '' ? {} : { thinkingDetail }),
          ...(rawOutput === undefined
            ? {}
            : { sourceBlocks: rawOutput.map(block => sourceBlock(block)) }),
          ...(request.status === 'error' ? { isError: true } : {}),
          timeSeconds: request.completedAt === null
            ? null
            : durationSeconds(request.completedAt, request.startedAt),
          startedAt: finiteTime(request.startedAt),
        }
        attachUsage(cell, request.usage as UsageLike | undefined)
        return [{ absTime: finiteTime(request.startedAt), cell }]
      })
      index += laid.length
      const groups: LaidGroup[] = [{ title: `Compaction ${request.startSeq}`, laid: [...laid] }]
      if (request.turn === null) standaloneCompactions.push({ groups, stepGroups: new Map() })
      else bucket(request.turn).groups.push(...groups)
      prevAbsTime = finiteTime(request.completedAt) ?? finiteTime(request.startedAt) ?? prevAbsTime
      continue
    }
    const { node, nodeIndex: i } = entry
    if (node.kind === 'user') {
      // user/message has no turn on the wire; enclose it in the next assistant
      // (or partial) turn, else open the turn after the last assistant.
      const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn)
      const laid = laidFor(cache, node, index + 1, EMPTY_DEPS, callSchemas, () => [{
        absTime: finiteTime(node.time),
        cell: {
          index: index + 1,
          kind: 'user',
          ...inputCellDetail(node),
          opensTurn: true,
        },
      }])
      index += laid.length
      for (const cell of laid) pushMessage(turn, cell)
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'steering') {
      const placement = steeringPlacement(
        followingAssistants[i],
        partial,
        lastAssistantTurn,
        eventLocations?.get(node.seq),
      )
      const laid = laidFor(cache, node, index + 1, EMPTY_DEPS, callSchemas, () => [{
        absTime: finiteTime(node.time),
        cell: {
          index: index + 1,
          kind: 'user' as const,
          ...inputCellDetail(node),
        },
      }])
      index += laid.length
      if (placement.step === undefined) for (const cell of laid) pushMessage(placement.turn, cell)
      else pushStepInput(placement.turn, placement.step, laid)
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'assistant') {
      const startIndex = index + 1
      const previousAbsTime = prevAbsTime
      const laidList = laidFor(
        cache,
        node,
        startIndex,
        assistantDeps(node, previousAbsTime, resultByCall, callStartById, callById),
        callSchemas,
        () => withSubCalls(expandAssistant(
          node, startIndex, previousAbsTime, resultByCall, callStartById, callById,
        )),
      )
      if (node.step > 0) pushStep(node.turn, node.step, laidList)
      else for (const laid of laidList) pushMessage(node.turn, laid)
      const last = laidList[laidList.length - 1]
      if (last !== undefined) index = last.cell.index
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      lastAssistantTurn = node.turn
      continue
    }
    if (node.kind === 'context') {
      const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn)
      const laid = laidFor(cache, node, index + 1, EMPTY_DEPS, callSchemas, () => [{
        absTime: finiteTime(node.time),
        cell: {
          index: index + 1,
          kind: 'context',
          ...inputCellDetail(node),
        },
      }])
      index += laid.length
      for (const cell of laid) pushMessage(turn, cell)
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'compaction') {
      // Chat owns the human-facing compaction marker. It contributes no
      // duplicate trajectory cell, but still advances the duration cursor.
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'tool-result') {
      if (!emittedCallIds.has(node.callId)) {
        const startIndex = index + 1
        const laidList = laidFor(cache, node, startIndex, EMPTY_DEPS, callSchemas, () => {
          let local = startIndex
          const toolName = node.call?.name
          const resultPreview = summarizeResult(node)
          const out: LaidCell[] = [{
            absTime: finiteTime(node.callTime ?? node.time),
            ...(toolName !== undefined ? { toolName } : {}),
            callId: node.callId,
            subCalls: node.subCalls,
            cell: {
              index: local,
              kind: 'tool',
              sourceSeq: node.seq,
              ...(node.call !== null
                ? summarizeCall(node.call.name, node.call.argsRaw)
                : resultAsText(resultPreview)),
              ...(node.call !== null ? { inputDetail: node.call.argsRaw } : {}),
              outputDetail: detailResult(node),
              outputBlocks: node.content.map(block => sourceBlock(block)),
              ...resultPreview,
              callId: node.callId,
              isError: node.isError,
              timeSeconds: durationSeconds(node.time, node.callTime),
              startedAt: finiteTime(node.callTime),
            },
          }]
          for (const laid of expandSubCalls(node.subCalls, local)) {
            out.push(laid)
            local = laid.cell.index
          }
          return out
        })
        const last = laidList[laidList.length - 1]
        if (last !== undefined) index = last.cell.index
        pushStep(0, 1, laidList)
      }
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
    }
  }

  if (partial !== null) {
    const fake: AssistantMessageNode = {
      kind: 'assistant', seq: Number.MAX_SAFE_INTEGER, time: 0,
      turn: partial.turn, step: partial.step, blocks: partial.blocks,
    }
    const laidList = withSubCalls(expandAssistant(
      fake,
      index + 1,
      prevAbsTime,
      resultByCall,
      callStartById,
      callById,
      { streaming: true },
    ))
    attachSchemas(laidList, callSchemas, cache)
    if (partial.step > 0) pushStep(partial.turn, partial.step, laidList)
    else for (const laid of laidList) pushMessage(partial.turn, laid)
    const last = laidList[laidList.length - 1]
    if (last !== undefined) index = last.cell.index
  }

  const seenCalls = runningCalls.length === 0 ? EMPTY_CALL_IDS : collectCallIds(turns)
  for (const call of runningCalls) {
    if (seenCalls.has(call.callId)) continue
    const laidList: LaidCell[] = [{
      absTime: null,
      toolName: call.name,
      callId: call.callId,
      subCalls: call.subCalls,
      cell: {
        index: ++index,
        kind: 'tool',
        ...summarizeCall(call.name, call.argsRaw),
        inputDetail: call.argsRaw,
        callId: call.callId,
        timeSeconds: null,
        startedAt: finiteTime(call.time),
      },
    }]
    for (const laid of expandSubCalls(call.subCalls, index)) {
      laidList.push(laid)
      index = laid.cell.index
    }
    attachSchemas(laidList, callSchemas, cache)
    if (call.step > 0) pushStep(call.turn, call.step, laidList)
    else for (const laid of laidList) pushMessage(call.turn, laid)
  }

  // Orphan turn-0 cells (orphaned tools) fold into Turn 1.
  const prologue = turns.get(0)
  if (prologue !== undefined) {
    turns.delete(0)
    const emptyTurn = (): TurnBucket => ({ groups: [], stepGroups: new Map() })
    const first = turns.get(1) ?? emptyTurn()
    first.groups = [...prologue.groups, ...first.groups]
    turns.set(1, first)
  }

  const ordered = [
    ...[...turns.entries()].map(([turn, entry]) => ({ key: `turn:${turn}`, turn, entry })),
    ...standaloneCompactions.map(entry => ({
      key: `compaction:${entry.groups[0]?.title ?? ''}`,
      turn: null,
      entry,
    })),
  ]
    .map(item => ({ ...item, order: firstBucketCellIndex(item.entry) }))
    .sort((left, right) => left.order - right.order)
  const retained = new Map<string, TurnRecord>()
  const models = ordered.map(item =>
    turnModelFor(cache, retained, item.key, item.turn, item.entry))
  if (cache === undefined) return models
  cache.turns = retained
  const previous = cache.result
  if (
    previous !== undefined
    && previous.length === models.length
    && models.every((model, at) => previous[at] === model)
  ) return previous
  cache.result = models
  return models
}

/** Dependencies an assistant expansion reads outside the node itself. */
function assistantDeps(
  node: AssistantMessageNode,
  prevAbsTime: number | null,
  results: ReadonlyMap<string, ToolResultNode>,
  callStarts: ReadonlyMap<string, number>,
  calls: ReadonlyMap<string, ToolCallBlock>,
): readonly unknown[] {
  const deps: unknown[] = [prevAbsTime]
  for (const block of node.blocks) {
    if (block.kind !== 'tool-call') continue
    deps.push(results.get(block.callId), callStarts.get(block.callId), calls.get(block.callId))
  }
  return deps
}

/**
 * Append the changing in-flight assistant cells to a stable finalized layout.
 * @param turns - Finalized layout derived with an empty-block partial anchor.
 * @param partial - Current in-flight assistant projection.
 * @param lastIndex - Highest cell index in the finalized layout.
 * @returns The original layout without a partial, otherwise a layout sharing every unaffected turn.
 */
export function appendTrajectoryPartialLayout(
  turns: readonly TrajectoryTurnModel[],
  partial: ConversationSnapshot['partial'],
  lastIndex: number,
): readonly TrajectoryTurnModel[] {
  if (partial === null) return turns
  const partialTurn = deriveTrajectoryLayout({
    nodes: [],
    partial,
    runningCalls: [],
  }).at(0)
  if (partialTurn === undefined) return turns
  const streamed: TrajectoryTurnModel = {
    ...partialTurn,
    groups: partialTurn.groups.map(group => ({
      ...group,
      cells: group.cells.map(cell => ({ ...cell, index: cell.index + lastIndex })),
    })),
  }
  const turnIndex = turns.findIndex(turn => turn.turn === streamed.turn)
  if (turnIndex === -1) return [...turns, streamed]
  const current = turns[turnIndex]
  /* v8 ignore next -- findIndex proved the dense array position exists. */
  if (current === undefined) return turns
  const groups = [...current.groups]
  for (const streamedGroup of streamed.groups) {
    const groupIndex = groups.findIndex(group => group.title === streamedGroup.title)
    if (groupIndex === -1) {
      groups.push(streamedGroup)
      continue
    }
    const group = groups[groupIndex]
    /* v8 ignore next -- findIndex proved the dense array position exists. */
    if (group === undefined) continue
    const streamedCallIds = new Set(
      streamedGroup.cells.flatMap(cell => cell.callId === undefined ? [] : [cell.callId]),
    )
    groups[groupIndex] = {
      ...streamedGroup,
      cells: [
        ...group.cells.filter(cell =>
          cell.requestOnly !== true
          && (cell.callId === undefined || !streamedCallIds.has(cell.callId)),
        ),
        ...streamedGroup.cells,
      ],
    }
  }
  const updated = [...turns]
  updated[turnIndex] = { ...current, groups }
  return updated
}

function toTurnModel(
  turn: number | null,
  entry: TurnBucket,
): TrajectoryTurnModel {
  const groups = entry.groups.map(({ title, laid }): TrajectoryGroupModel => {
    const description = groupDescription(laid)
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map(l => l.cell),
    }
  })
  return { turn, groups }
}

/** Chronological section position from the fold's monotonically assigned cell indexes. */
function firstBucketCellIndex(entry: TurnBucket): number {
  let first = Number.POSITIVE_INFINITY
  for (const group of entry.groups) {
    for (const laid of group.laid) {
      if (laid.cell.index < first) first = laid.cell.index
    }
  }
  return first
}

/** Wall-span duration + tool histogram, e.g. `1.5 s bash×6`. */
function groupDescription(laid: readonly LaidCell[]): string | undefined {
  const parts: string[] = []
  // Tool rows contribute start (absTime) and end (start + own duration) so a
  // single Tool cell still spans call→result for the group wall clock.
  const times: number[] = []
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue
    times.push(l.absTime)
    if (l.cell.kind === 'tool' && l.cell.timeSeconds !== null && Number.isFinite(l.cell.timeSeconds)) {
      times.push(l.absTime + l.cell.timeSeconds * 1000)
    }
  }
  if (times.length >= 2) {
    const span = formatGroupDuration((Math.max(...times) - Math.min(...times)) / 1000)
    if (span !== undefined) parts.push(span)
  } else if (times.length === 1) {
    const own = laid.find(l => l.absTime === times[0])?.cell.timeSeconds
    const span = own !== null && own !== undefined ? formatGroupDuration(own) : undefined
    if (span !== undefined) parts.push(span)
  }
  const tools = new Map<string, number>()
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== 'tool') continue
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1)
  }
  for (const [name, count] of tools) {
    parts.push(count > 1 ? `${name}×${count}` : name)
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

function formatGroupDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined
  return formatElapsedSeconds(seconds)
}

/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
function durationSeconds(later: number, earlier: number | null): number | null {
  if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null
  return Math.max(0, (later - earlier) / 1000)
}

/** Epoch-ms usable as an absolute time, else null. */
function finiteTime(time: number | null | undefined): number | null {
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

function expandAssistant(
  node: AssistantMessageNode,
  startIndex: number,
  prevAbsTime: number | null,
  results: Map<string, ToolResultNode>,
  callStarts: ReadonlyMap<string, number>,
  calls: ReadonlyMap<string, ToolCallBlock>,
  opts?: { streaming?: boolean },
): LaidCell[] {
  if (opts?.streaming === true && node.blocks.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex - 1
  const usage = node.usage as UsageLike | undefined
  const streaming = opts?.streaming === true
  const recordedStart = finiteTime(node.timing?.stepStartTime)
  const messageDuration = streaming
    ? null
    : durationSeconds(node.time, recordedStart ?? prevAbsTime)
  const nodeAbs = streaming ? null : finiteTime(node.time)
  const messageText = node.blocks
    .filter(block => block.kind === 'text' && (!streaming || block.text !== ''))
    .map(block => block.kind === 'text' ? block.text : '')
    .join('\n\n')
  const thinkingText = node.blocks
    .filter(block => block.kind === 'reasoning' && (!streaming || block.text !== ''))
    .map(block => block.kind === 'reasoning' ? block.text : '')
    .join('\n\n')
  const message: TrajectoryCellProps = {
    index: ++index,
    recordId: `assistant\u0000${node.turn}\u0000${node.step}`,
    kind: 'message',
    sourceSeq: node.seq,
    text: messageText !== '' || thinkingText !== ''
      ? ''
      : summarizeAssistantActivity(node.blocks),
    ...(messageText !== ''
      ? { previewMarkdown: messageText }
      : thinkingText !== ''
        ? { previewMarkdown: thinkingText }
        : {}),
    ...(messageText !== '' ? { outputDetail: messageText } : {}),
    ...(thinkingText !== '' ? { thinkingDetail: thinkingText } : {}),
    sourceBlocks: node.blocks.map(block => assistantSourceBlock(block)),
    timeSeconds: messageDuration,
    startedAt: recordedStart,
  }
  attachUsage(message, usage)
  message.assistantMetrics = {
    timingRecorded: node.timing !== undefined,
    stepStartTime: node.timing?.stepStartTime ?? null,
    firstTokenTime: node.timing?.firstTokenTime ?? null,
    completedTime: streaming ? null : finiteTime(node.time),
    usageProvided: usage !== undefined,
    outputTokens: Number.isFinite(usage?.outputTokens) ? usage?.outputTokens ?? null : null,
  }
  out.push({ absTime: nodeAbs, cell: message })

  for (const block of node.blocks) {
    // Text and reasoning belong to the one Assistant record emitted above.
    if (block.kind !== 'tool-call') continue
    const result = results.get(block.callId)
    const toolDuration = streaming || result === undefined
      ? null
      : durationSeconds(result.time, result.callTime)
    const callAbs = finiteTime(callStarts.get(block.callId))
    const call = calls.get(block.callId)
    const resultPreview = result === undefined ? undefined : summarizeResult(result)
    out.push({
      absTime: callAbs,
      toolName: block.name,
      callId: block.callId,
      ...(call === undefined ? {} : { subCalls: call.subCalls }),
      cell: {
        index: ++index, kind: 'tool',
        ...summarizeCall(block.name, block.argsRaw),
        inputDetail: block.argsRaw,
        callId: block.callId,
        ...(result !== undefined
          ? {
            outputDetail: detailResult(result),
            outputBlocks: result.content.map(block => sourceBlock(block)),
            ...resultPreview,
            isError: result.isError,
          }
          : {}),
        timeSeconds: toolDuration,
        startedAt: callAbs,
      },
    })
  }
  return out
}

function summarizeAssistantActivity(blocks: readonly AssistantBlock[]): string {
  const tools = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind !== 'tool-call') continue
    tools.set(block.name, (tools.get(block.name) ?? 0) + 1)
  }
  if (tools.size > 0) {
    return 'Tool call only'
  }
  return ''
}

function promptChangeLabel(change: RequestPromptChange): string {
  if (change.kind === 'initial') return 'Initial System Prompt'
  if (change.kind === 'system') return 'System Prompt Updated'
  if (change.kind === 'tools') return 'Tools Updated'
  return 'System Prompt and Tools Updated'
}

function assistantSourceBlock(block: AssistantBlock): TrajectorySourceBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', content: block.text }
    case 'reasoning': return { type: 'thinking', content: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      content: block.argsRaw,
      callId: block.callId,
      toolName: block.name,
    }
    // Attachment refs carry no fetchable bytes, so the record shows the
    // durable metadata instead of an inline preview.
    case 'image': return {
      type: 'image',
      content: stringifySourceValue(block.attachment),
    }
    case 'other': return sourceBlock(block.block)
  }
}

function sourceBlock(value: unknown): TrajectorySourceBlock {
  if (typeof value !== 'object' || value === null) {
    return { type: 'unknown', content: stringifySourceValue(value) }
  }
  const block = value as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  if (typeof block.text === 'string') {
    return { type: type === 'reasoning' ? 'thinking' : type, content: block.text }
  }
  const imageSrc = sourceImage(block)
  const imageAlt = typeof block.alt === 'string' ? block.alt : undefined
  return {
    type,
    content: imageSrc === undefined ? stringifySourceValue(value) : '',
    ...(imageSrc !== undefined ? { imageSrc } : {}),
    ...(imageAlt !== undefined ? { imageAlt } : {}),
  }
}

function sourceImage(block: Record<string, unknown>): string | undefined {
  if (typeof block.type !== 'string' || !block.type.toLowerCase().includes('image')) return undefined
  for (const candidate of [block.url, block.image_url]) {
    if (typeof candidate === 'string') return safeImageSource(candidate)
  }
  if (typeof block.data === 'string') {
    const mediaType = [block.mimeType, block.mediaType, block.media_type]
      .find((candidate): candidate is string => typeof candidate === 'string')
      ?? 'image/png'
    return safeImageSource(
      block.data.startsWith('data:')
        ? block.data
        : `data:${mediaType};base64,${block.data}`,
    )
  }
  if (typeof block.source !== 'object' || block.source === null) return undefined
  const source = block.source as Record<string, unknown>
  if (typeof source.url === 'string') return safeImageSource(source.url)
  if (typeof source.data !== 'string') return undefined
  const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
  return safeImageSource(`data:${mediaType};base64,${source.data}`)
}

function safeImageSource(value: string): string | undefined {
  if (value.startsWith('data:image/') || value.startsWith('blob:')) return value
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

function stringifySourceValue(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json || String(value)
}

/**
 * Turn that encloses a user/message: next assistant turn, else the
 * in-flight partial, else the turn after the last finalized assistant (or 1).
 */
function enclosingUserTurn(
  followingAssistant: AssistantMessageNode | undefined,
  partial: ConversationSnapshot['partial'],
  lastAssistantTurn: number | null,
): number {
  if (followingAssistant !== undefined) return followingAssistant.turn
  if (partial !== null) return partial.turn
  if (lastAssistantTurn !== null) return lastAssistantTurn + 1
  return 1
}

function steeringPlacement(
  followingAssistant: AssistantMessageNode | undefined,
  partial: ConversationSnapshot['partial'],
  lastAssistantTurn: number | null,
  location: ConversationLocation | undefined,
): { turn: number; step?: number } {
  if (location?.kind === 'step') {
    return { turn: location.turn.turn, step: location.step.step }
  }
  const locatedTurn = location?.kind === 'turn' ? location.turn.turn : undefined
  if (followingAssistant !== undefined
    && (locatedTurn === undefined || followingAssistant.turn === locatedTurn)) {
    return {
      turn: followingAssistant.turn,
      ...(followingAssistant.step > 0 ? { step: followingAssistant.step } : {}),
    }
  }
  if (partial !== null && (locatedTurn === undefined || partial.turn === locatedTurn)) {
    return { turn: partial.turn, ...(partial.step > 0 ? { step: partial.step } : {}) }
  }
  if (locatedTurn !== undefined) return { turn: locatedTurn }
  return { turn: lastAssistantTurn ?? 1 }
}

function enclosingPromptTurn(
  nodes: ConversationSnapshot['nodes'],
  seq: number,
  partial: ConversationSnapshot['partial'],
): number {
  const next = nodes.find(node =>
    node.seq > seq && node.kind === 'assistant' && node.step > 0)
  if (next?.kind === 'assistant') return next.turn
  return partial?.turn ?? 1
}

/** Earliest raw turn represented by the selected trajectory branch. */
function firstVisibleTurn(
  nodes: ConversationSnapshot['nodes'],
  partial: ConversationSnapshot['partial'],
): number {
  const turns = nodes.flatMap(node =>
    node.kind === 'assistant' && node.turn > 0
      ? [node.turn]
      : [],
  )
  if (partial !== null && partial.turn > 0) turns.push(partial.turn)
  return turns.length === 0 ? 1 : Math.min(...turns)
}

/** Copy provider usage onto a Message cell when present. */
function attachUsage(cell: TrajectoryCellProps, usage: UsageLike | undefined): void {
  if (usage === undefined) return
  if (usage.inputTokens !== undefined) cell.input = usage.inputTokens
  if (usage.cacheReadTokens !== undefined) cell.cacheRead = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) cell.cacheWrite = usage.cacheWriteTokens
  if (usage.outputTokens !== undefined) cell.output = usage.outputTokens
  if (usage.reasoningTokens !== undefined) cell.think = usage.reasoningTokens
}

function collectCallIds(
  turns: Map<number, TurnBucket>,
): Set<string> {
  const ids = new Set<string>()
  for (const entry of turns.values()) {
    for (const group of entry.groups) {
      for (const laid of group.laid) {
        if (laid.callId !== undefined) ids.add(laid.callId)
      }
    }
  }
  return ids
}



/** Interleave each tool cell's nested child calls right after it, reindexing followers. */
function withSubCalls(laidList: LaidCell[]): LaidCell[] {
  if (!laidList.some(laid => laid.subCalls !== undefined && laid.subCalls.length > 0)) return laidList
  const out: LaidCell[] = []
  let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0
  for (const laid of laidList) {
    out.push({ ...laid, cell: { ...laid.cell, index: ++index } })
    for (const sub of expandSubCalls(laid.subCalls, index)) {
      out.push(sub)
      index = sub.cell.index
    }
  }
  return out
}

/** Sub-dispatch cells for one run_code parent, in start order (running = null duration). */
function expandSubCalls(
  subs: readonly ToolCallBlock[] | undefined,
  startIndex: number,
): LaidCell[] {
  if (subs === undefined || subs.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex
  for (const sub of subs) {
    const settled = 'kind' in sub
    const resultPreview = settled ? summarizeResult(sub) : undefined
    const laid: LaidCell = {
      absTime: settled ? finiteTime(sub.callTime ?? sub.time) : finiteTime(sub.time),
      toolName: settled ? sub.call?.name ?? sub.callId : sub.name,
      callId: sub.callId,
      cell: {
        index: ++index,
        kind: 'subtool',
        callId: sub.callId,
        ...(settled
          ? (sub.call !== null
            ? summarizeCall(sub.call.name, sub.call.argsRaw)
            : resultAsText(resultPreview))
          : summarizeCall(sub.name, sub.argsRaw)),
        ...(settled
          ? (sub.call !== null ? { inputDetail: sub.call.argsRaw } : {})
          : { inputDetail: sub.argsRaw }),
        ...(settled
          ? {
            outputDetail: detailResult(sub),
            outputBlocks: sub.content.map(block => sourceBlock(block)),
            ...resultPreview,
            isError: sub.isError,
          }
          : {}),
        // The code-dispatch start/settle pair carries per-sub-call wall time;
        // a running (unsettled) or pre-pair log entry shows the em dash.
        timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
        startedAt: settled
          ? finiteTime(sub.callTime)
          : finiteTime(sub.time),
      },
    }
    out.push(laid)
    for (const child of expandSubCalls(sub.subCalls, index)) {
      out.push(child)
      index = child.cell.index
    }
  }
  return out
}

function summarizeCall(
  name: string,
  argsRaw: string,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return {
    text: name,
    ...(argsRaw === '' ? {} : { previewMarkdown: argsRaw }),
  }
}

function summarizeResult(
  node: ToolResultNode,
): Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> {
  if (node.isError) {
    return { result: node.error?.code ?? 'error' }
  }
  for (const block of node.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return { result: '', resultPreviewMarkdown: block.text }
    }
  }
  return { result: 'No output' }
}

function resultAsText(
  result: Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> | undefined,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return {
    text: result?.result ?? '',
    ...(result?.resultPreviewMarkdown === undefined
      ? {}
      : { previewMarkdown: result.resultPreviewMarkdown }),
  }
}

function detailResult(node: ToolResultNode): string {
  if (node.isError) {
    return node.error === undefined
      ? 'error'
      : `${node.error.name}: ${node.error.code}`
  }
  const text = node.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  if (text !== '') return text
  if (
    node.content.length === 0
    || node.content.every(block =>
      block.type === 'text' && (typeof block.text !== 'string' || block.text === ''))
  ) return 'No output'
  return JSON.stringify(node.content, null, 2)
}

function detailContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function detailReasoning(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function previewContent(
  content: readonly { type: string; text?: string }[],
): string | undefined {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

function previewContentProperty(
  content: readonly { type: string; text?: string }[],
): Pick<TrajectoryCellProps, 'previewMarkdown'> {
  const previewMarkdown = previewContent(content)
  return previewMarkdown === undefined ? {} : { previewMarkdown }
}

/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { ToolExecutorUnavailableError } from './executor.ts'
import type { ToolExecutor, ToolBatchInput, ToolBatchResult } from './executor.ts'
import './events.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { projectToolSchema, ToolArgsError } from './schema.ts'
import { assertSupportedJsonSchema } from './json-schema.ts'
import { RUN_CODE_NAME, ToolActivationError } from './contracts.ts'
import type {
  ToolDefinition, ToolRestriction, ToolExecution, ToolGuard, ToolRunContext,
  ResolvedToolSet, ToolActivationContext, ToolRegistrationOptions,
} from './contracts.ts'
import { compileToolDeferPolicy, TOOL_SEARCH_NAME } from './defer.ts'
import type { CompiledToolDeferPolicy, ToolDeferConfig, ToolDeferPolicy, ToolDeferral } from './defer.ts'
import { createToolSearchTool } from './tool-search.ts'

declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Step-owned tool selection; absent when inspecting registered definitions. */
    toolSet?: ResolvedToolSet
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Tool availability changes supplied by the tool registry. */
    'tool-registry': { kind: 'tool-registry' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }
}

/**
 * The tool names a Session's last logged request header declared. Reads
 * defensively: a Session before its first request, or a stand-in without
 * request-header history, seeds no activations.
 * @param session - the created or resumed agent's Session, as far as it exists.
 * @returns the declared names, empty when there is no logged header.
 */
function loggedToolNames(session: Partial<Pick<Agent['session'], 'requestHeader'>> | undefined): string[] {
  if (typeof session?.requestHeader !== 'function') return []
  return session.requestHeader()?.tools?.map(tool => tool.name) ?? []
}

/** The policy in force without any declaration: only tools that set `deferLoading` are deferred. */
const DEFER_LOADING_ONLY = compileToolDeferPolicy({})

/** Registry configuration. */
export interface ToolsConfig {
  /** Removed. Mount a native or PTC tool executor instead. */
  mode?: never
  /** Moved to the PTC tool executor configuration. */
  maxParallelSubCalls?: never
  /**
   * Tools listed by name only for scopes that declare no policy of their own
   * ({@link ToolsService.deferAs} shadows it per scope). A deferred tool stays
   * callable; its full declaration is fetched with `tool_search`. Tools that
   * set `deferLoading` are deferred unless `exclude` names them. Default: no
   * patterns.
   */
  defer?: ToolDeferConfig | undefined
}

/** One restriction compiled at registration for repeated live-global lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One registered definition and its step-time activation condition. */
interface ToolRegistration {
  readonly definition: ToolDefinition
  readonly when: ToolRegistrationOptions['when']
}

/** One scope's complete registry view, derived in a single layer traversal. */
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and inherited restrictions. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Registrations behind {@link visible}, keyed by the same names. */
  readonly registrations: ReadonlyMap<string, ToolRegistration>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

/** One scope's complete tool-registry contribution. */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolRegistration>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  /** Defer policy this scope declared for itself; the nearest declaration on a scope chain wins. */
  defer: CompiledToolDeferPolicy | undefined

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty() && this.defer === undefined
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

}

interface Registration {
  executor: ToolExecutor | undefined
}

class GuardLayer {
  readonly guards = new AnonymousEntries<ToolGuard>()
  isEmpty(): boolean { return this.guards.isEmpty() }
}

/** Concrete tool registry and scoped executor dispatcher. */
export class ToolsService extends Service {
  static inject = ['systemPrompt']
  static Config = z.object({
    mode: z.never().description('Removed. Mount a native or PTC tool executor instead.'),
    maxParallelSubCalls: z.never().description('Moved to the PTC tool executor configuration.'),
    // Absent stays absent: an empty policy would shadow the deployment default.
    defer: z.union([z.const(undefined), z.object({
      include: z.array(z.string().min(1)),
      exclude: z.array(z.string().min(1)),
    })]).description('Tools listed by name only for scopes without a defer policy of their own; `tool_search` returns their declarations.'),
  })

  private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change') })
  private readonly scoped = new WeakMap<ScopeKey, Registration>()
  private root: Registration | undefined
  private readonly guards = new ScopedLayers(() => new GuardLayer(), () => {})
  /** The registry's own context, which owns registry-lifetime prompt sections. */
  private readonly registryCtx: Context
  /** Defer policy for scopes that declare none; {@link deferAs} shadows it per scope. */
  private readonly defaultDefer: CompiledToolDeferPolicy
  /** Whether the global deferred-index section is registered. */
  private deferredIndexRegistered = false
  /**
   * Deferred tools each agent activated through a direct `tool_search` call,
   * seeded on resume from the tools its last logged request header declared.
   */
  private readonly activations = new WeakMap<ScopeKey, Set<string>>()
  /** Reserved declaration lookup, built on first need. */
  private toolSearch: ToolDefinition | undefined

  constructor(ctx: Context, config: ToolsConfig = {}) {
    super(ctx, 'tools')
    this.registryCtx = ctx
    this.defaultDefer = config.defer === undefined ? DEFER_LOADING_ONLY : compileToolDeferPolicy(config.defer)
    ctx.systemPrompt.tools(({ scope, toolSet }) => {
      const executor = this.selectExecutor(scope)
      const definitions = this.definitions(scope, toolSet)
      const description = executor.describe(definitions, this.deferralOf(scope, definitions))
      const search = definitions.some(definition => definition.name === TOOL_SEARCH_NAME) ? [TOOL_SEARCH_NAME] : []
      return { ...description, knownNames: description.knownNames ?? [...this.view(scope).knownNames, ...search] }
    })
    // A resumed agent keeps the deferred tools its model was last offered:
    // the logged request header is the record of that declaration list.
    ctx.on('agent/created', ({ agent }) => {
      const names = loggedToolNames(agent.session)
      if (names.length > 0) this.activations.set(agent, new Set(names))
      return undefined
    })
    // The deferred index exists only where something can be deferred: here
    // for a deployment policy, per scope in deferAs(), and on the first
    // deferLoading tool otherwise (see requireDeferredIndex).
    if (config.defer !== undefined) this.requireDeferredIndex()
  }

  /**
   * Register the global deferred-index section once, owned by the registry
   * itself so it lives as long as the registry rather than the first registrant.
   */
  private requireDeferredIndex(): void {
    if (this.deferredIndexRegistered) return
    this.deferredIndexRegistered = true
    this.registryCtx.systemPrompt.section(this.deferredIndexSection())
  }

  /**
   * The name-only index of the viewing scope's deferred tools, rendered by
   * the selected executor's {@link ToolExecutor.deferredIndex}; an executor
   * without one renders it empty. It lists every deferrable tool, activated
   * or not, so a `tool_search` activation leaves the prompt unchanged.
   * @returns the section registration.
   */
  private deferredIndexSection(): PromptSection {
    return {
      name: 'tools:deferred',
      order: this.registryCtx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      interpolate: false,
      text: ({ scope, toolSet }) => {
        const executor = this.selectExecutor(scope)
        if (executor.deferredIndex === undefined) return ''
        const definitions = this.definitions(scope, toolSet)
        const { deferrable } = this.deferralOf(scope, definitions)
        return deferrable.size === 0 ? '' : executor.deferredIndex(definitions.filter(definition => deferrable.has(definition.name)))
      },
    }
  }

  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` and
   * `tool_search` names fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @param options - optional step-time activation condition.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    // Reserved unconditionally: any agent may select a code mode for itself,
    // so a name free to take under the deployment default would become a
    // collision the moment a preset mounted.
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
    }
    if (name === TOOL_SEARCH_NAME) {
      throw new Error(`tool name "${TOOL_SEARCH_NAME}" is reserved for deferred tool lookup and cannot be registered or shadowed`)
    }
    if (definition.deferLoading === true) this.requireDeferredIndex()
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, { definition, when: options.when }),
      { label: 'tools.register()' },
    )
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * List the calling scope's tools named by `policy` by name only instead of
   * applying the deployment default policy. Nearest scope on the chain wins,
   * so a preset's standing declaration covers every agent joined under it.
   * Scoped only, and one declaration per scope.
   * @param policy - include and exclude name patterns.
   * @returns the exact disposer that restores the deployment default.
   * @throws when called on an unscoped context, a pattern is empty, or the scope already declared a policy.
   */
  deferAs(policy: ToolDeferPolicy): () => void {
    if (scopeOf(this.ctx) === undefined) {
      throw new Error('tools.deferAs() requires a scoped context (agent.ctx): a context-global policy is the `defer` config field on the tools row')
    }
    const compiled = compileToolDeferPolicy(policy)
    const ctx = this.ctx
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous composite teardown; preserve the Cordis disposer identity
    return ctx.effect(function* (this: ToolsService) {
      yield this.layers.effect(
        ctx,
        (layer) => {
          if (layer.defer !== undefined) {
            throw new Error('tools.deferAs() is already declared for this scope; one composition selects one defer policy')
          }
          layer.defer = compiled
          return () => { layer.defer = undefined }
        },
        { label: 'tools.deferAs()' },
      )
      // Per scope: a scoped section reaches exactly the agents under it.
      yield ctx.systemPrompt.section(this.deferredIndexSection())
    }.bind(this), 'tools.deferAs()')
  }

  /**
   * The defer policy one scope's agent sees: the nearest declaration on its
   * scope chain, else the deployment default.
   * @param scope - the calling agent, or undefined for the global view.
   * @returns the compiled policy.
   */
  private deferFor(scope?: ScopeKey): CompiledToolDeferPolicy {
    const layers = this.layers.chainLayers(scope)
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const defer = layers[index]?.defer
      if (defer !== undefined) return defer
    }
    return this.defaultDefer
  }

  /**
   * Sort one scope's capability definitions into declared and listed by name
   * only. `tool_search` itself is never deferred.
   * @param scope - the viewing agent, or undefined for the global view.
   * @param definitions - the scope's visible definitions for one step.
   * @returns the deferrable names and those the agent has not activated.
   */
  private deferralOf(scope: ScopeKey | undefined, definitions: readonly ToolDefinition[]): ToolDeferral {
    const policy = this.deferFor(scope)
    const activated = scope === undefined ? undefined : this.activations.get(scope)
    const deferrable = new Set<string>()
    const deferred = new Set<string>()
    for (const definition of definitions) {
      if (definition.name === TOOL_SEARCH_NAME || !policy.defers(definition.name, definition.deferLoading === true)) continue
      deferrable.add(definition.name)
      if (activated?.has(definition.name) !== true) deferred.add(definition.name)
    }
    return { deferrable, deferred }
  }

  /**
   * Append the reserved lookup to registered definitions exactly while one of
   * them is deferred for the scope.
   * @param scope - the viewing agent, or undefined for the global view.
   * @param registered - the scope's registered definitions for one step.
   * @returns the definitions, with `tool_search` last when something is deferred.
   */
  private withToolSearch(scope: ScopeKey | undefined, registered: ToolDefinition[]): readonly ToolDefinition[] {
    return this.deferralOf(scope, registered).deferrable.size > 0 ? [...registered, this.requireToolSearch()] : registered
  }

  /**
   * The scope's deferrable definitions for one step, activated or not.
   * @param scope - the viewing agent.
   * @param toolSet - the step admission, or undefined outside a model step.
   * @returns the deferrable definitions in registry order.
   */
  private deferrableDefinitions(scope: ScopeKey | undefined, toolSet: ResolvedToolSet | undefined): ToolDefinition[] {
    const definitions = this.definitions(scope, toolSet)
    const { deferrable } = this.deferralOf(scope, definitions)
    return definitions.filter(definition => deferrable.has(definition.name))
  }

  /**
   * Render declarations in the selected executor's program format for a call
   * made inside a program.
   * @param tools - the tools to declare.
   * @param exec - the call that needs them.
   * @returns the declaration text, or undefined for a direct call or an executor without a program format.
   */
  private programDeclarations(tools: readonly ToolDefinition[], exec: ToolExecution): string | undefined {
    // An unloaded executor still settles accepted calls; their declarations fall back to JSON.
    return exec.parent === undefined ? undefined : this.findExecutor(exec.agent)?.programDeclarations?.(tools)
  }

  /**
   * The reserved `tool_search` lookup, built on first need. Like `run_code`
   * it stays outside the filterable layers; the registry appends it per scope.
   * @returns the shared lookup definition.
   */
  private requireToolSearch(): ToolDefinition {
    this.toolSearch ??= createToolSearchTool({
      deferredTools: (exec: ToolRunContext) => this.deferrableDefinitions(exec.agent, exec.toolSet),
      renderDeclarations: (tools, exec) => this.programDeclarations(tools, exec)
        ?? JSON.stringify(tools.map(jsonDeclaration), null, 2),
      activate: (scope, names) => {
        const activated = this.activations.get(scope) ?? new Set<string>()
        for (const name of names) activated.add(name)
        this.activations.set(scope, activated)
      },
    })
    return this.toolSearch
  }

  /**
   * Attach a deferred tool's declaration to its argument error, because the
   * model calling it may never have read that declaration. A call inside a
   * program gets its executor's SDK format, a direct call the JSON schema.
   * @param error - the tool's argument validation failure.
   * @param exec - the failed call.
   * @returns the error, extended when the tool is deferred for the caller.
   */
  explainArgsError(error: ToolArgsError, exec: ToolExecution): ToolArgsError {
    const definition = this.deferrableDefinitions(exec.agent, exec.toolSet).find(candidate => candidate.name === exec.name)
    if (definition === undefined) return error
    const extended = new ToolArgsError(error.violations)
    const declaration = this.programDeclarations([definition], exec) ?? JSON.stringify(jsonDeclaration(definition), null, 2)
    extended.message = `${error.message}\nDeclaration of ${exec.name}:\n${declaration}`
    return extended
  }

  /**
   * Resolve visible tools and pre-restriction names. Restrictions across the
   * scope chain intersect over inherited global and ancestor tools; the viewing
   * scope's own registrations remain exempt. Nearer registrations shadow
   * farther ones. Pre-restriction names support restriction and prompt-order validation.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    const layers = this.layers.chainLayers(scope)
    const own = this.layers.peek(scope)
    const inherited = new Map(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration)
    }
    const visible = new Map<string, ToolDefinition>()
    const registrations = new Map<string, ToolRegistration>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, registration] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      if (layers.every(layer => layer.admits(name))) {
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    if (own !== undefined) {
      for (const [name, registration] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    return { visible, registrations, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    if (name === TOOL_SEARCH_NAME) return this.definitions(scope, toolSet).find(definition => definition.name === name)
    return toolSet === undefined ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name)
  }

  /**
   * Resolve the definition a call may execute. With a step's admitted set, the
   * set decides; without one, conditional registrations are unavailable.
   * @param name - the tool name as registered.
   * @param scope - the calling agent; omitted = the global view.
   * @param toolSet - step admission, or omitted for a call outside a model step.
   * @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
   */
  executable(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    if (name === TOOL_SEARCH_NAME) return this.get(name, scope, toolSet)
    if (toolSet !== undefined) return toolSet.view(scope).get(name)
    const view = this.view(scope)
    return view.registrations.get(name)?.when === undefined ? view.visible.get(name) : undefined
  }

  /**
   * Resolve conditions once for this step without changing shared registrations.
   * Cancellation or a rejected condition publishes no partial selection. Removed
   * registrations cannot be restored by a late condition result.
   * @param context - preparing agent, captured model selection, and cancellation.
   * @returns the complete selection; the caller disposes it after its tool batch settles.
   */
  async resolve(context: ToolActivationContext): Promise<ResolvedToolSet> {
    const { agent, signal } = context
    signal.throwIfAborted()
    const view = this.view(agent)
    const admitted = new Map<string, ToolDefinition>()
    for (const [name, definition] of view.visible) {
      const registration = view.registrations.get(name)
      let enabled: boolean
      try {
        enabled = registration?.when === undefined || await registration.when(context)
      } catch (cause: unknown) {
        signal.throwIfAborted()
        throw new ToolActivationError(name, cause)
      }
      signal.throwIfAborted()
      if (enabled) admitted.set(name, definition)
    }
    let closed = false
    return Object.freeze({
      dispose: () => { closed = true },
      view: (scope: ScopeKey | undefined): ReadonlyMap<string, ToolDefinition> => {
        const visible = new Map<string, ToolDefinition>()
        if (closed || scope !== agent) return visible
        const current = this.view(agent)
        for (const [name, definition] of admitted) {
          if (current.visible.get(name) === definition
            && current.registrations.get(name) === view.registrations.get(name)) {
            visible.set(name, definition)
          }
        }
        return visible
      },
    })
  }

  /**
   * Read the visible capability definitions for descriptions and program
   * bindings. While the scope defers one of them, the reserved `tool_search`
   * lookup follows them.
   * @param scope - viewing Agent or preset; omitted selects the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
   */
  definitions(scope?: ScopeKey, toolSet?: ResolvedToolSet): readonly ToolDefinition[] {
    return this.withToolSearch(scope, toolSet === undefined ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()])
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission, or omitted for registered-definition inspection.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[] {
    return this.definitions(scope, toolSet).map(definition => projectToolSchema(definition, true))
  }
  /**
   * Provide the executor for the calling scope; an unscoped contribution is the deployment default.
   * Rendering any executor-owned section requires the viewing scope's selection to remain available.
   * @param executor - initialized provider owned by the contributing plugin.
   * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
   */
  setExecutor(executor: ToolExecutor): () => void {
    const scope = scopeOf(this.ctx)
    const existing = scope === undefined ? this.root : this.scoped.get(scope)
    if (existing?.executor !== undefined) throw new Error('Only one tool executor may be registered in each scope')
    const record: Registration = { executor }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    return this.ctx.effect(function* (this: ToolsService) {
      for (const section of executor.sections ?? []) {
        yield this.ctx.systemPrompt.section({
          name: section.name,
          order: section.order,
          ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
          text: ({ scope, toolSet }) => {
            if (this.selectExecutor(scope) !== executor) return ''
            if (typeof section.text !== 'function') return section.text
            const definitions = this.definitions(scope, toolSet)
            return section.text(definitions, this.deferralOf(scope, definitions))
          },
        })
      }
      if (scope === undefined) this.root = record
      else this.scoped.set(scope, record)
      yield () => {
        // Keep an unavailable selection so a program cannot fall through to a different executor.
        record.executor = undefined
      }
    }.bind(this), 'tools.setExecutor()')
  }

  /**
   * Resolve the nearest scoped provider, or the deployment default.
   * @param scope - Agent or preset scope; omitted selects only the root contribution.
   * @returns the selected executor; throws when it is missing or unloaded.
   */
  private selectExecutor(scope?: ScopeKey): ToolExecutor {
    const executor = this.findExecutor(scope)
    if (executor === undefined) throw new ToolExecutorUnavailableError()
    return executor
  }

  /**
   * Resolve the nearest scoped provider, or the deployment default, without failing.
   * @param scope - Agent or preset scope; omitted selects only the root contribution.
   * @returns the selected executor, or undefined when it is missing or unloaded.
   */
  private findExecutor(scope?: ScopeKey): ToolExecutor | undefined {
    let record: Registration | undefined
    for (const key of scopeChainOf(scope)) {
      record = this.scoped.get(key)
      if (record !== undefined) break
    }
    record ??= this.root
    return record?.executor
  }

  /**
   * Delegate a raw call batch to its Agent's provider or the deployment default.
   * Select at dispatch; accepted batches settle through that provider even if it unloads.
   * @param input - original calls, optional owning Agent, and optional logging step.
   * @returns the selected executor's settled batch; unavailable selections reject.
   */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return this.selectExecutor(input.agent).execute(input)
  }

  /**
   * Register a monotonic denial in the calling scope.
   * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
   * @returns the effect disposer that removes this guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.guards.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()' })
  }

  /**
   * Check global and inherited guards after pre-execute policy and approval resolve.
   * @param exec - invocation whose guards are checked before dispatch.
   * @returns the first denial reason, or undefined when no guard denies.
   */
  checkGuards(exec: ToolExecution): string | undefined {
    for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) {
      for (const guard of layer.guards.values()) {
        const reason = guard(exec)
        if (reason !== undefined) return reason
      }
    }
    return undefined
  }

}

/** The JSON declaration a direct call reads: the model-facing schema fields. */
function jsonDeclaration({ name, description, parameters }: ToolDefinition): Pick<ToolSchema, 'name' | 'description' | 'parameters'> {
  return { name, description, parameters }
}

export default ToolsService

export { TOOL_SEARCH_NAME } from './defer.ts'
export { nativeIndexLead, programIndexLead, renderDeferredIndex } from './defer.ts'
export type { DeferredToolEntry, ToolDeferConfig, ToolDeferPolicy, ToolDeferral } from './defer.ts'
export * from './contracts.ts'
export * from './executor.ts'
export * from './schema.ts'
export * from './json-schema.ts'
export * from './presentation.ts'
export { ToolsService as ToolRuntime }

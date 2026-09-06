# Agent Note: Independent Host client runtimes

Status: implemented

English | [中文](2026-09-06-independent-host-client-runtimes.zh.md)

## Problem

A browser shell can present Sessions from several Hosts whose local ids overlap. Reusing one Client service tree would mix Connection generations, Remote namespaces, Session scopes, Workspace mirrors, feature-request responses, and presentation state. Mounting a complete shell per Host would duplicate the renderer and Slot declarations, while leaving local UI registrations active during a remote selection would retain callbacks closed over the wrong Host.

## Decision

`@deepseek-ai/dsh-client-environment-runtime` gives every acquired Host a fresh Cordis root. The Host carrier supplies unary and stream transport; the shell's injected Connection factory creates an independent Connection before a trusted dependency-closed domain roster activates. The runtime publishes immutable environment and activation identities, exposes a feature-request service restricted to registered relative `/api/` routes, and fences completion against Connection generation loss or replacement.

The Web boot kernel exposes one activator backed by the trusted boot manifest and memoized module system. Products validate required roots with `available()`, derive domain, presentation, and suspension closures, and state which package faces are already provided. A remote selection withdraws unsafe local presentation entries, projects the selected runtime's required Cordis services into a short-lived presentation context, and activates those entries against the shell's one renderer, layout, locale, theme, and Slot registry. Returning local or changing Host disposes that presentation before releasing the runtime lease; the last lease disposes the runtime and carrier.

The local environment runtime owns `ctx.environmentNavigation` and its bounded compound presentation store for the shell lifetime. Locations and persisted Store state use `{ environmentId, sessionId }`, while Slot callbacks and Host APIs keep the native Session id. Drafts, selected views and details, scroll anchors, and sidebar mode therefore do not collide. The active snapshot reports connection state and last-connect time; retry reconnects the same mounted runtime. During an asynchronous presentation swap, the Slot registry retains the previous root standard sources and scope adapter until their replacements install. `ui-environment-navigation` contributes an overview, an Activity bell and body within the existing Workspaces region, and a server footer action; its withdrawal cannot tear down the navigation service or the product coordinator that injects it.

## Alternatives considered

**One shared Client root with a replaceable transport** was rejected because Cordis services, event listeners, generations, and apply-owned caches would retain identities from the preceding Host and allow late work to publish into the new selection.

**One complete application shell per Host** was rejected because it duplicates root Slot declarations, renderers, layout state, and persistent navigation instead of giving presentation one visible owner.

**Keeping local presentation active beneath remote UI** was rejected because local callbacks and module-owned resources could still issue commands through the local `ctx.sessions` or `ctx.remote` after the visible Session belonged to another Host.

## Consequences

Independent Hosts can use equal Session ids without sharing runtime or presentation state, and late requests cannot cross a generation boundary. The product composition must maintain explicit trusted rosters and distinguish domain providers, remote presentation entries, persistent shell services, and unsafe local registrations. A Host switch remounts presentation plugins, so state that must survive belongs in the shell-owned compound presentation store rather than apply-owned module caches. Loader lifecycle tests cover withdrawal, restoration, service ownership, and single-renderer behavior; runtime tests cover context isolation, lease disposal, route authorization, and generation fencing.

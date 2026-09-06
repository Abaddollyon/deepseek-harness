# Agent Note: Passive interactions and named client surfaces

Status: implemented

English | [中文](2026-09-05-passive-interactions-and-client-surfaces.zh.md)

## Problem

Small authenticated browser companions need two pieces of host state without inheriting the full Web application: a read-only view of interactions that already wait for a person, and a boot graph that contains only the packages required by that companion. The existing approval and question waterfalls intentionally own answer authority, while the existing index renderer always publishes the ordinary root graph.

## Decision

The interaction layer provides `ctx.pendingInteractions` as a process-local observational registry. Approval and question services bracket only their actual answerer dispatch with `begin()` and its idempotent end capability; snapshots and queued deltas expose opaque identity, kind, optional agent/session identity, epoch, revision, and timestamps without request contents or an answer method. Observer failure, delay, disposal, and late subscription cannot affect the authoritative waterfall described by the [approval seam](../feature/2026-07-06-approval-seam.md) and [Web permission and approval](../feature/2026-07-23-web-permission-and-approval.md).

Distribution closure follows that ownership boundary. An assembly that ships the approval or question services also ships `dsh-pending-interactions`; the Python SDK runtime names the registry directly rather than relying on automatic peer installation. Public discriminator properties exposed through generated client maps carry explicit literal types, so reflection and declaration generation see the same contract as TypeScript consumers.

The client module layer provides `ctx.clientSurfaces`. A registration names an exact path, explicit roots, and one root plugin. Registration fails when an id, path, root, or required injected dependency is unavailable; lookup composes the current transitive `inject` and dynamic `external` closure. A `dsh.client.defaultRoot: false` package stays out of the ordinary graph unless an ordinary root depends on it, so packages without this metadata retain the existing Web boot behavior.

Connection accepts only a registered surface id when producing or authorizing a non-root launch URL. Browser authentication exchanges the process token only on the registry-selected exact pathname and redirects to the same clean pathname. Frontend Static recognizes that registered path as an index entry and passes its id through WebServer's generic index-render variant, allowing Client Modules to inject the matching graph while other index contributors remain shared.

## Safety properties

The passive registry contains no request body, approval decision, question answer, or blocking observer acknowledgement. A missing registry preserves the approval and question behavior that predates this seam. Agent and service disposal close records, while observer callbacks are queued and failure-contained.

A surface URL carries only the existing launch token query and never accepts a caller-supplied return path. Unregistered paths remain static misses, an unknown surface id cannot mint a URL, registration disposal removes path discovery, and the graph closure excludes unrelated full-application packages. Surface clients use ordinary Connection Fetch/RPC channels and do not require a Gateway event client.

## Alternatives considered

**Mirror pending interactions into durable session events.** Rejected because unanswered waterfall state is process-local and transient; durable replay could resurrect a dead prompt or imply answer authority in an observer.

**Let companions filter the full boot graph in the browser.** Rejected because omitted packages would already have been advertised and fetched, and the companion would inherit unrelated startup work and dependency authority.

**Pass an arbitrary path or return URL through the launch token.** Rejected because the host registry already owns the exact trusted path and a caller-controlled redirect would widen the authentication boundary.

**Use Gateway events for the companion.** Rejected because the passive snapshot/delta transport fits authenticated Connection channels and the companion does not need the full session event stream.

## Consequences

Core now has two reusable seams rather than avatar-specific behavior: interaction producers publish lifecycle only, and any browser companion can register a dependency-closed surface. The cost is another process-local registry and graph composition per surface render; registrations must enumerate roots accurately, distribution roots must declare the passive registry, and disappearance of a required package makes the path undiscoverable until the dependency returns.

Focused tests pin normal no-surface behavior, exact token exchange and clean redirect, two independent surface fixtures, dependency closure, forbidden-package exclusion, registration conflicts and disposal, cancellation and failures in interaction dispatch, observer failure containment, and late observers.

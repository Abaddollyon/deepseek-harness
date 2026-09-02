# Agent Note: Session Model-Route Projection

Status: implemented

English | [中文](2026-08-19-session-model-route-projection.zh.md)

## Problem

Which provider and model a Session actually runs on existed only on the Host. `RequestContext` is durable — the agent loop appends `request/context` whenever the provider, model, or advertised capacity differs from the previous request — but the only reader was `Session.requestContext()`, a Host-side accessor. Nothing carried the route to a browser, so a client listing Sessions could show a composed `agentPreset` name at best and nothing at all for a preset-less deployment. A mixed-model swarm — several child Sessions on different routes running side by side — was indistinguishable row by row.

Capacity alone already reached clients through `contextPressure.contextWindow`, which proves the transport works; the identity beside it did not travel.

## Decision

`@deepseek-ai/dsh-token-meter` registers a fourth session-projection unit under the key `modelRoute`, serving `{ provider, model, contextWindow? }` folded last-wins from `request/context`. `request/context` carries the complete post-change route, so the fold is one event type and one assignment: [`src/route-projection.ts`](../../../../packages/llm/token-meter/src/route-projection.ts). The key, its payload type, and the `SessionProjectionMap` merge live in the package's client-safe outlet [`src/projection.ts`](../../../../packages/llm/token-meter/src/projection.ts), reachable from browser aggregates through the existing `@deepseek-ai/dsh-token-meter/client` namespace. Registration joins the package's existing optional `ctx.inject(['sessionProjections'], …)` child fiber, so unloading the meter removes the key with the other three.

### Absence is `null`, not a missing key

The registry serves every registered unit in every snapshot, so a key cannot be conditionally absent. `modelRoute` is therefore `ModelRouteProjection | null`, `null` until the Session's first request logs a route and for the whole life of a Session that never issues one. The sentinel is a value rather than an undefined field because a projection value crosses JSON transports, where an `undefined` field is dropped and a stale route would survive on the receiving side — the same reason the `subagent` identity projection carries `null`. No placeholder route is ever invented.

### Model-agnostic by construction

The fold copies `provider` and `model` verbatim out of the logged record and compares them only for equality. No provider list, model list, alias table, family heuristic, or fallback route exists in the unit, so the value reports whatever route the composition resolved and a new adapter needs no change here. `contextWindow` is present exactly when the logged route advertised one; a later route without capacity drops the field rather than carrying the previous number forward.

### Why token-meter owns it

`request/context` already has exactly one fold home in this repository: token-meter's `contextPressure` unit reads the same event for its capacity denominator. Putting the route beside it keeps one package interpreting one durable record, and keeps `contextWindow` — published by both units — derived at a single site. token-meter is also already composed wherever `ctx.sessionProjections` exists (the base and web-app bundles and all three runnable examples), so the key reaches every Session that has a projection registry with no new composition row, bundle dependency, or client registration surface.

## Alternatives considered

**A new single-projection package (`model-route`).** It matches token-meter's stated charter better — measurement, not identity — and session-stats is the precedent for a one-projection package. It was rejected because it would make a second package fold `request/context` and independently publish `contextWindow`, splitting one durable record across two owners for one three-field value, and because the key would then exist only where that package was separately composed. The charter tension is answered in prose instead: the README now states that the measurement service resolves no route of its own and that `modelRoute` only republishes what the loop logged.

**Extend `contextPressure` with `provider` and `model`.** `contextPressure` is explicitly documented as a set of independent last-wins records that is *not* one atomic request observation, and its fields are absent until a provider reports usage. Route identity is known one event earlier and is exact, so folding it into an approximate occupancy value would inherit an inaccuracy it does not have and would make a consumer wanting only the route depend on usage having been reported.

**Serve the route from a Host RPC instead of a projection.** Projections already ride `SessionSummary.projectionValues` for every Session in a list without a per-Session subscription, which is exactly the mixed-swarm read. A dedicated call would add a request per row and would not replay from a cold checkpoint.

**Report the route only after a request succeeds.** The loop appends `request/context` before dispatch, so a success-gated value would need a second event and a cross-event correlation. The read is an identity display, not a billing or gating input, so the earlier and simpler record wins; the README records that a route every subsequent request fails on still reports as current.

## Consequences

- Any client reading `SessionSummary.projectionValues.modelRoute` gets per-Session provider/model identity with no vendor knowledge on either side; a deployment whose adapter advertises no capacity simply omits `contextWindow`.
- Sessions gain one more projection key, so each Session's checkpoint row set and each snapshot grow by one small JSON value, and a route change emits one additional change-feed frame.
- token-meter's package charter now includes one non-measurement fact. The README states the split so the estimator's route independence is not read as a contradiction.
- Consumers must treat `null` as "no route yet" rather than an error; the value is never partially filled.
- The first cold restore of a Session whose persisted projection cache predates the key reads its log from seq 0: `restoreFloor` pulls the floor to zero for a key with no row, and `restore` refolds it from `init` without throwing because that floor is zero. Every later restore uses the refreshed rows.

## Testing

[`tests/model-route-projection.spec.ts`](../../../../packages/llm/token-meter/tests/model-route-projection.spec.ts) covers the null before any request, a Session that logs turns but never requests, the first record, an omitted capacity, last-wins across a mid-Session route change, a capacity dropped by a newer route, one change-feed emission per distinct route with none for a repeated record, cold replay by `seq` reproducing the live value (including the null case), and key removal when the meter fiber disposes. [`tests/loader-composition.spec.ts`](../../../../packages/llm/token-meter/tests/loader-composition.spec.ts) boots the shipped YAML shape through the vendored Loader and asserts the composed registry serves all four keys, starts `modelRoute` at `null`, and publishes each resolved route on the change feed.

## Related

[Projected Token Usage and Request Context](../architecture/2026-07-29-projected-token-usage-and-request-context.md) owns `request/context` as a capacity record and the deliberately non-atomic occupancy pair; this note adds the identity reader of the same event and does not change that decision.

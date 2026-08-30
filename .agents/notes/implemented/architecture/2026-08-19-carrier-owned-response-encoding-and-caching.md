# Agent Note: the Web carrier owns response encoding and caching

Status: implemented

English | [中文](2026-08-19-carrier-owned-response-encoding-and-caching.zh.md)

## Problem

The Web carrier previously let every route write directly to the socket. That left content-coding negotiation, body-size decisions, and cache headers spread across route owners, with no shared answer for a route added later.

That split is especially risky for browser assets. A query parameter such as `?rev=<hash>` is not, by itself, proof that the carrier is serving bytes whose identity is independently known. A cache policy that treats every such URL as immutable can pin stale bytes when a route or deployment changes its naming contract.

The carrier therefore needs one source-owned policy with a bounded decision buffer, explicit exclusions, truthful response state, and a test seam that can drive transform and socket events without opening a listener.

## Decision

**Encoding and caching belong to the carrier, not to each route.** `WebServer` installs one response patch (`packages/host/webserver/src/response-policy.ts`) before dispatch, so named routes, the fallback seat, and carrier-generated 400/404 answers share one policy without knowing its implementation.

**The decision buffer is bounded by `compressMinBytes`.** The value is normalized to a finite non-negative threshold. A body below the threshold is flushed verbatim; the exact crossing splits the retained prefix from the streamed suffix; an oversized `end()` call retains at most the threshold and passes the remainder to the transform. A threshold of zero or a negative value starts compression immediately. The carrier never stores a complete large response just to decide whether to encode it.

**Candidacy is an allow-list.** Text and the named structured types are eligible. Existing encodings, `Cache-Control: no-transform`, range responses, HEAD and bodiless statuses, `text/event-stream`, and already-compressed media remain verbatim. `Vary: Accept-Encoding` is added to every eligible response, including one that ends below the threshold or selects identity.

**Negotiation follows the client's weights.** Brotli is preferred over gzip when the client gives them equal weight, q-values can reverse that order, and identity is the safe fallback when no offered coding is usable. The carrier does not answer 406 merely because it cannot select a compression coding.

**Only an immutable pathname prefix earns an immutable cache directive.** The default source policy recognizes `/assets/`; query parameters, including `?rev=<hash>`, do not qualify. The carrier-generated default for HTML is `no-cache`, and every other unprefixed answer is revalidated. A handler-supplied `Cache-Control` remains authoritative, so an explicit route contract is not silently replaced.

**Lifecycle state belongs to the patch while raw I/O remains native.** `headersSent` follows the policy phase, `finished` and `writableEnded` become true when the route requests logical end, and `writableFinished` waits for the physical `finish` event. A `write()` callback means carrier or transform acceptance; an `end()` callback is held until the physical raw `end()` callback. A `close` after physical finish is a normal terminal notification; only a `close` before physical finish is treated as cancellation. The exact per-write socket-ack time is not observable through this contract.

**Input and output backpressure are separate.** Transform input can block while the raw sink remains writable, and a blocked raw sink pauses the transform readable side. A public `drain` is owed once and dispatched only after both blockers clear. `on`, `once`, `addListener`, `off`, `removeListener`, and listener clearing preserve the carrier's lifecycle listeners and the route's registration semantics.

**Failure and abort use one teardown controller.** Transform errors are reported once through `onError`, outstanding callbacks receive the same error once, and the unfinished transform and response are destroyed in a guarded order. Client aborts settle callbacks with cancellation without reporting a compressor error, and neither path emits a spurious `finish`.

**Source and artifact configuration are separate evidence planes.** The source `WebServer.Config` defaults are `compress: true`, `compressMinBytes: 1024`, `brotliQuality: 5`, `gzipLevel: 6`, `immutablePathPrefixes: ['/assets/']`, and `immutableMaxAgeSeconds: 31536000`. The shipped Web composition separately sets `compress: true`, `compressMinBytes: 1024`, `brotliQuality: 5`, `gzipLevel: 1`, `immutablePathPrefixes: ['/assets/']`, and `immutableMaxAgeSeconds: 31536000` in `packages/bundle/web-app/cordis.patch.yml`. The source tests do not stand in for proof that the artifact was shipped with those values.

**The real composition test observes the Loader path.** `packages/host/webserver/tests/webserver.spec.ts` boots a temporary `cordis.yml` through the vendored Loader, uses the WebServer defaults, and requests default-policy, small, `/assets/`, and `/plugins/?rev=` routes. It asserts raw Brotli bytes, identity below the default threshold, immutable cache only for the configured asset prefix, and `no-cache` for the query-only plugin URL. The source-local runtime seam covers the same lifecycle transitions deterministically without claiming socket or artifact evidence.

## Measured effect

This note makes no production traffic, byte-count, or cache-hit claim. The measurable local contract is the source-level evidence above: deterministic transform tests report the changed policy source at 100% statements, branches, functions, and lines, while the Loader test is the separate runtime-composition check. Artifact values are read from the shipped Web composition file and are not inferred from source defaults.

## Alternatives considered

**A connect-style `compression` middleware.** Rejected because this carrier has no middleware chain, middleware would not own cache classification, and `node:zlib` already supplies the two required transforms.

**A broad compression database or deny-list.** Rejected in favor of the small allow-list: the default-deny behavior is the safety property for opaque or already-compressed payloads.

**Per-route compression in `frontend-static`, `client-modules`, and `/api`.** Rejected because it duplicates threshold, negotiation, exclusion, and failure logic and leaves future routes uncovered.

**Inferring immutability from any filename hash or query parameter.** Rejected because the carrier cannot prove another route's naming convention hashes the served bytes. The explicit pathname-prefix configuration states the deployment contract instead.

**ETag or Last-Modified validators.** Deferred. They may reduce the body cost of revalidated answers later, but they do not replace content-coding negotiation or the explicit immutable-prefix contract.

## Consequences

Every response now gets one consistent encoding and cache decision. Route owners must state an exceptional `Cache-Control` or `Content-Encoding` explicitly; otherwise unprefixed answers revalidate and eligible large bodies stream through the selected coding.

The carrier pays request-time compression CPU and keeps a bounded prefix while deciding. Streaming handlers using a compressible media type must either use the intended threshold behavior or call `flushHeaders()`; SSE and other explicitly excluded response classes continue directly to the socket.

The immutable-prefix setting is a deployment contract. Pointing it at files that are rewritten in place can pin stale bytes in browsers, so the default is narrow and query-only revisions do not expand it.

## Testing

`packages/host/webserver/tests/response-policy.spec.ts` covers negotiation, q-values, media-type eligibility, cache classification, all cache and exclusion headers, real node:http terminal paths, exact threshold crossings, oversized writes and ends, callback settlement, separate compressor/sink backpressure, drain bookkeeping, header overloads, frozen headers, transform errors, raw sink errors, and client abort before and after compression. Its source-local `ResponsePolicyRuntime` seam supplies deterministic transforms and scheduling; production `applyResponsePolicy` remains the shipped entry point.

`packages/host/webserver/tests/webserver.spec.ts` supplies real vendored-Loader composition evidence for the WebServer defaults and raw HTTP behavior. Run it where local socket binding is permitted; a static or injected test cannot substitute for that runtime receipt.

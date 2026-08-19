# Agent Note: the Web carrier owns response encoding and caching

Status: implemented

English | [中文](2026-08-19-carrier-owned-response-encoding-and-caching.zh.md)

## Problem

A cold load of the Web GUI moved 4,587,681 B across 46 requests, every one of them identity-encoded and none of them reusable.

Nothing in the composition ever looked at `Accept-Encoding`. The shell document, the hashed `/assets/` chunks, the 41 plugin bundles under `/plugins`, and every `/api` JSON answer were written straight to the socket by their owning handler. Measured against the running server: the entry document 12,842 B, `/assets/vendor-<hash>.js` 744,872 B, `/assets/index-<hash>.js` 442,711 B, one conversation-UI bundle 428,418 B — all unchanged whether or not the client sent `--compressed`. The largest single line item was the client-plugin payload at roughly 3.3 MB across 41 bundles.

Caching was worse than absent, because it was actively defeated. The `/plugins` route stated `cache-control: no-cache` on every bundle even though the boot graph already mints each URL as `/plugins/<id>/client.js?rev=<sha1 prefix of the bytes>` — a URL that cannot go stale, refetched in full on every reload. Everything else carried no directive at all, which leaves the decision to browser heuristics.

The two WebSocket downlinks that carry every server-to-browser frame ran with `perMessageDeflate` off, so the repetitive JSON envelopes went out raw.

## Decision

**Encoding and caching belong to the carrier, not to each route.** `WebServer` installs one response patch (`packages/host/webserver/src/response-policy.ts`) on every request before it dispatches, so the named routes, the fallback seat, and the carrier's own 400/404 answers all get the same treatment without knowing it exists. The alternative — teaching `frontend-static`, `client-modules`, and the `/api` bridge each to negotiate — would have put one decision in three places and left the next route to rediscover it.

**The patch defers `writeHead` until it knows the answer.** It buffers a compression candidate until the body either ends under `compressMinBytes`, in which case it flushes verbatim under the handler's own headers, or reaches the threshold, at which point it commits `Content-Encoding`, drops `Content-Length`, and streams the rest through a `node:zlib` transform. Buffering is therefore bounded by the threshold, and a large answer is never fully resident. Preference is brotli, then gzip, then identity, with the client's own q-values ahead of that order.

**Candidacy is an allow-list of media types.** `text/*` plus a named set (`application/json`, `application/wasm`, `image/svg+xml`, `+json`/`+xml` suffixes). An already-compressed payload — PNG, WOFF2, ZIP, video — is skipped by not being named, which is also why no deny-list needs maintaining. `text/event-stream` is excluded although it is text: an SSE channel stays open for its lifetime, so buffering it to measure a threshold would withhold every event. A HEAD request, a bodiless status, and a body the handler already encoded are equally out.

**An unmentioned `identity` takes the lowest weight the client stated.** This is `negotiator`'s convention, not RFC 9110's literal reading: a client sending `br;q=0.9, gzip;q=0.8` is asking to be encoded, and treating "acceptable by default" as q=1 would refuse both codings it just offered. A client that offers nothing gets identity, and the carrier never answers 406 — an asset the browser cannot render is a worse answer than one coding it did not rank.

**`Vary: Accept-Encoding` goes on every candidate, including one answered uncompressed**, because the same URL answers differently per client.

**A URL is pinned only when it carries its own content hash.** Two signals: the `?rev=` parameter the boot graph mints over the bundle bytes, and placement under an `immutablePathPrefixes` entry, defaulting to `/assets/`, where the [dist chunk layout](2026-08-06-web-shell-dist-chunk-layout.md) writes every file as `<name>-<hash><ext>`. Both mean a rebuild that changes the bytes changes the URL, which is what licenses `public, max-age=31536000, immutable`.

**Everything else revalidates, and that is what keeps the GUI current.** `no-cache` — stored, but never reused without asking — not `no-store`, so an unchanged answer still ends in a cheap 304. The entry document is never content-addressed and therefore always revalidates; it is the document that names the current asset and bundle URLs, so as long as it is refetched, a new build's hashed URLs are new URLs and are fetched with it. Pinning it would freeze the whole app.

**An HTML body never earns `immutable`, whatever its URL looks like.** The SPA fallback answers a miss anywhere — including under `/assets/` — with index.html and status 200, so without this rule one mistyped hashed URL would pin the shell in a browser under an address the build never emits again. This is the one place where getting the policy wrong is unrecoverable from the server side, so it is enforced on the response's media type rather than on the URL that produced it.

**A handler that states its own `Cache-Control` keeps it**, which is how `/plugins/events` and the `/api` SSE channel keep theirs. The `/plugins` bundle route no longer states one: its URLs are content-addressed, so the carrier pins the bundle and leaves the hash-less source map revalidated, which is the correct answer the route's blanket `no-cache` was hiding.

**Pinning a bundle obliges every requester to carry the current hash**, because a pinned answer is reused without reaching the host at all. The dev hot-reload path is the one requester that did not: it refetched the boot URL and relied on the route's `no-cache` to be handed the rebuilt bytes. A `rebuilt` frame already names the new hash, so the browser half now moves that graph row onto it (`ClientModuleLoader.revise`) before refetching, which makes the reload a different URL and closes the [stale graph rev](../../../../packages/client/hmr/README.md) the old directive was papering over.

**`headersSent` answers from the patch's own phase.** node:http reports it from the bytes on the socket, which the patch deliberately withholds while it measures. The carrier's per-request error containment asks the question to choose between an error status and destroying the socket, and the answer it needs is whether the handler's head is still changeable.

**The downlinks offer permessage-deflate with context takeover left at the RFC 7692 default.** The sliding window across frames is where most of the ratio comes from on a stream that repeats one envelope format; the cost is one zlib context per direction per socket, and a deployment that cannot afford it turns the extension off.

**Every threshold, level, and toggle is a validated Config field.** On `WebServer`: `compress` (`true`), `compressMinBytes` (`1024`), `brotliQuality` (`5`), `gzipLevel` (`6`), `immutablePathPrefixes` (`['/assets/']`), `immutableMaxAgeSeconds` (`31536000`). On `client-connection`: `webSocketCompress` (`true`), `webSocketCompressThreshold` (`1024`), `webSocketCompressLevel` (`6`), `webSocketCompressConcurrencyLimit` (`10`). Brotli quality 5 rather than the format's maximum because 11 targets build-time precompression; the server preference order, the compressible media set, and the `rev` parameter name stay fixed as protocol and format facts.

## Measured effect

Against the dist the running server serves, replayed through the new policy with a browser's own `Accept-Encoding: gzip, deflate, br, zstd`:

| Resource | Before | After (br q5) | Reduction |
|---|---|---|---|
| entry document | 12,842 B | 1,906 B | 85.2% |
| `/assets/index-<hash>.js` | 442,711 B | 143,764 B | 67.5% |
| `/assets/vendor-<hash>.js` | 744,872 B | 167,732 B | 77.5% |
| `/plugins/…/ui-conversation/client.js` | 428,418 B | 94,166 B | 78.0% |
| whole cold load, 46 requests | 4,587,681 B | 1,051,058 B | 77.1% |

Of those 46 answers, 45 are now `immutable` and exactly one — the entry document — revalidates, so a reload costs one conditional request plus whatever the new build actually changed.

## Alternatives considered

**The `compression` middleware.** It is the maintained implementation of exactly the buffering-then-streaming algorithm used here, and repository policy prefers a dependency that deletes owned code. Rejected because it is connect-style middleware for a carrier that has no middleware chain, it answers only half the problem (nothing about caching), and it would pull `accepts`, `negotiator`, `bytes`, `compressible`, `mime-db`, `on-headers`, and `debug` — a CJS dependency tail larger than the roughly 150 lines it replaces, on the source-launch path that must stay ESM-resolvable. `node:zlib` already supplies both codings; only the negotiation and the response patch are ours, and both are covered by focused tests.

**`compressible` alone, for the media-type question.** Rejected for the same reason at a worse ratio: mime-db to replace one seven-entry allow-list, whose deny-by-default behavior is the property we actually want.

**Compressing in `frontend-static`, `client-modules`, and the `/api` bridge separately.** Rejected as three copies of one decision, with three chances to disagree about the threshold and no answer for a route added later.

**Precompressing the dist at build time** (`.br`/`.gz` siblings served by content negotiation). Better CPU at request time and it would allow brotli quality 11 on the static half. Rejected here because it covers only the files a build emits — not `/api` JSON, which the audit measured at 1,088,001 B for a 50-message history page — and because it makes the serving path depend on a build step the dev loop does not always run. It stays available as a later addition beside this policy, not instead of it.

**Detecting content-addressing from the filename alone** (a `-<hash>.<ext>` pattern anywhere). Rejected as unsafe in both directions: it would match an ordinary `my-component.js` and miss a build whose hash format differs. The prefix list states the deployment's actual layout and fails visibly when it is wrong.

**`ETag` or `Last-Modified` validators.** Deferred, not rejected. They would turn the revalidated answers into 304s without a body, but the only frequently revalidated answer is the 12 KB entry document, and the routes — not the carrier — own the facts a validator is computed from.

## Consequences

The cold load drops by 77.1%, and a reload drops to one conditional request instead of 4.6 MB. The cost is CPU per request on the encoded answers and a bounded buffer per response.

Every route now answers with headers it did not write. A handler that wants different caching states it explicitly; a handler that wants no encoding sets `Content-Encoding` itself or uses a media type outside the allow-list. Streaming handlers keep working because `text/event-stream` is excluded and `flushHeaders` degrades to passthrough, but a future streaming handler using a compressible media type without either would be buffered up to `compressMinBytes` before its first byte moved.

`immutablePathPrefixes` is a loaded default. A deployment that points it at a directory whose files the build rewrites in place pins stale bytes in every browser that fetched them, and no server-side change can recall them. The HTML rule bounds the damage to non-HTML assets; the README states the constraint where the field is documented.

## Testing

`packages/host/webserver/tests/response-policy.spec.ts` pins the negotiation table (server preference, client q-values, wildcards, unparseable weights, the identity fallback, no 406), the media-type allow-list, and the cache decisions as pure functions, then asserts the HTTP behavior over a real node:http server: brotli and gzip bodies that decode back to the original, identity when the client offers nothing, no encoding under the threshold or on an already-compressed payload, `Content-Length` dropped only when encoding, chunk-by-chunk bodies encoded once past the threshold, an SSE event delivered before any end, and the cache directives each URL earns.

`packages/host/webserver/tests/webserver.spec.ts` carries the real-Loader composition case: a browser's Accept-Encoding against the booted server yields brotli on the entry document, a hashed asset, and a `?rev=` bundle, with the identity answers measured beside them and the cache directives asserted per URL.

`packages/client/connection/tests/websocket-downlink.host.spec.ts` asserts the extension is negotiated with the shipped settings, absent when the deployment turns it off, and transparent to the frames either way.

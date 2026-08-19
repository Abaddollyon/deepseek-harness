# Agent Note: Conversation rendering bounds its per-frame and per-mount costs

Status: implemented

English | [中文](2026-08-19-conversation-render-cost-bounds.zh.md)

## Problem

A render audit of the conversation domain measured four unbounded costs on the browser main thread.

Syntax highlighting is a synchronous shiki scan with no length cap: highlighting a 20,578-character TSX file took **663 ms** in one task, and the cost is linear in the source (≈10 ms per 1,000 characters of TSX on this desktop). `CodeBlock` and `ReadBlock` hand `highlightToHtml`/`highlightLines` whatever their caller gives them, so one large fence or one large read card freezes the tab for most of a second.

The lazy-grammar load notification was one global counter. `CodeBlock` and `ReadBlock` used it as a `useSyncExternalStore` snapshot, so any one of the 23 lazy grammars landing invalidated the highlight memo of **every** mounted surface in the transcript. Re-highlighting the 82 fences of a real corpus costs **15.5 ms** per storm, and a session touching several languages pays it repeatedly, each storm landing at whatever moment a network chunk resolved. Composed with the uncapped scan, a storm over a transcript holding one large fence is catastrophic.

A settled message's element tree lived only in its component instance's `useMemo`, so every unmount re-parsed it from source on the next mount. Re-mounting a 205-block / 215,157-character corpus costs **293 ms** of parse and element construction.

`ChatView`'s scroll handler, when `document.elementsFromPoint` misses — the jsdom, pre-layout, image-loading and fast-fling cases — measured **every** mounted anchor row with `getBoundingClientRect` inside one scroll event: O(5,677) forced layouts on the largest measured session. `JsonTree` installed an unthrottled capture-phase `window` scroll listener per instance, so every scroll in the document reached every mounted JSON surface and, with a row hovered, cost two forced layouts plus a React state update per instance per event. `JsonTree` also re-rendered its whole tree on every row hover: `JsonTreeNode` was not memoized and received a fresh callback, a fresh path array, and a rebuilt entries array on every parent render.

## Decision

**Highlighting is bounded and its results are retained.** `highlight.ts` gains a `HighlightConfig` with `maxSourceChars` (built-in 10,000) and `cacheEntries` (built-in 128 per output form). Above the cap `highlightToHtml` and `highlightLines` report "no highlighting" without tokenizing and without requesting a grammar, and the callers draw the identical-geometry plain `<pre>` they already had for unknown languages. Under it, results are retained in a least-recently-used cache keyed on `(grammar id, source)`, so a re-render is a lookup. The cap is checked before the grammar request on purpose: an oversized surface must not pull a 637 kB grammar chunk it will never use.

**Grammar-load notification is per grammar.** `grammarLoadSource(lang)` returns a subscribe/snapshot pair cached per resolved grammar id (and one inert pair for languages that resolve to no grammar, which can never gain highlighting). A `python` module landing notifies python surfaces and nothing else. The pair's identity is stable for the document's lifetime, so calling it on every render never resubscribes. This replaces `subscribeGrammarLoaded`/`grammarLoadCount`, whose only consumers were `CodeBlock` and `ReadBlock`.

**A settled Markdown render is retained across mounts.** `MarkdownText` gains a module-level least-recently-used cache of settled element trees, bounded by `MarkdownRenderConfig.settledCacheEntries` (built-in 256). The key is `(text, codeLabels identity, fileMentions identity)`: the produced elements captured those two objects' callbacks — `renderSettled` bakes `fileMentions.resolve` handlers into anchors, which is exactly why the streaming arm forces `fileMentions: undefined` — so a tree built for one owner must never be served to another. Identities are minted lazily into a `WeakMap`, so a dead session's resolver simply stops producing hits and its entries evict. Streaming renders are not cached; the incremental parser already owns that path and is the best-optimized code in the domain.

This is a pure render cache in a cordis-free package, not a store. The client layering rule that forbids module-level handles governs *stores* — de-facto singletons holding business state that something subscribes to. These caches hold recomputable products of their inputs, publish nothing, and observe nothing; `highlight.ts`'s `HighlighterCore` singleton is the same category and the existing precedent.

**Both bounds are deployment values, not constants.** `ui-primitives` is cordis-free by design, so it exposes `configureHighlighting` and `configureMarkdownRendering`, each returning a disposer that restores the previous values and drops the caches on both edges. The `ui-conversation` host plugin gains a validated `Config` — `rendering.highlightMaxChars`, `rendering.highlightCacheEntries`, `rendering.markdownCacheEntries` — and registers it as the base layer of a new `ui-conversation-rendering` settings namespace. The browser half binds that namespace and installs the present fields from a `ctx.effect`, so disposal returns the shared modules to their built-in values.

The settings namespace is the channel because there is no other one: `WebBootEntry` (`packages/client/modules/src/client/manifest.ts`) carries `id`, `url`, `rev`, `inject` and `immediately` — no per-entry `config` — so a browser-half plugin cannot receive cordis.yml config directly today. Every field is optional and `ui-primitives` owns the built-in each omitted field keeps, so there is exactly one home for each default.

**`ChatView`'s anchor scan is logarithmic and its element construction is memoized.** The fallback that measured every mounted row is replaced by a binary search over the anchor rows: they stack in document order, so their bottom edges increase monotonically and the first row reaching the scrollport is found in O(log n) layout reads. The winner is the same row the old filter chose. The seat list is built inside a `useMemo` over the seat inputs, so a scroll-threshold flip or an unrelated publication no longer re-creates one element per mounted Node. The turn-start scan runs only while a turn is actually running.

**Scroll handling is throttled where a frame of latency is invisible, and left synchronous where it is not.** `JsonTree`'s capture-phase window listener coalesces into one `requestAnimationFrame` callback and writes the copy anchor's position straight to the element's style instead of through React state, so a scroll costs no render at all. `ChatView`'s handler stays synchronous: browsers already deliver `scroll` at most once per frame, so rAF coalescing there buys close to nothing while adding a frame of latency to the documented reader-versus-programmatic ownership protocol, which compares the delivered `scrollTop` against the `observedTopRef` ledger and drives bottom-follow. Making the per-event work cheap is the actual fix; deferring it is a risk with no measured payoff.

**`JsonTree` rows bail out on hover.** `JsonTreeNode` is memoized, and everything that would have defeated the bailout is stabilized in the same change: `onRowHover`, `setActiveRow` and `clearCopyTarget` are `useCallback`s reading live values through refs, per-child path arrays are derived once per `(path, value)`, and `entriesOf` runs once per value instead of once per parent render. Hovering a row still re-renders the `JsonTree` root — the copy affordance's menu depends on the hovered value — but the rows below it no longer re-run `entriesOf` and the recursive preview.

## What the owner-prop audit found

The audit flagged as unverified whether the owner props reaching `ChatNodeSeat` are reference-stable, warning that every `memo` in this domain would be dead if they are not. **They are stable**, so the memoization above pays off. In `packages/client/web-react/src/scoped-slots.tsx` the owner object is spread into the component, so what matters is per-value identity, not the object's: `standardProps` caches the whole standard kit per `(host, scope, provide info)`, `observableHook` caches each hook per source, `boundRenderSlot`/`boundRenderSlotChain` cache per entry in a `WeakMap`, `localeSeat` caches per `(face, namespace, revision)`, and `cachedSessionInject` caches the whole inject face per `(entry, provide info)`. `openFile`, `inspectCall`, `forkAt`, `loadImage`, `fileMentions`, `chatScroll` and `loadOlder` all arrive through that last cache. No change was needed there.

`ChatNodeSeat`'s owner `useMemo` listed `node` in its dependency array without using it; it now depends on the Node's presence instead. The effect is small — the dispatched `routedOwner` is a fresh spread either way — but the dependency was misleading about what the memo protects.

## Testing

`packages/client/ui-primitives/tests/render-cost.client.spec.tsx` pins the new behavior: a rust grammar landing leaves the `highlightToHtml` call count of the mounted TypeScript and shell fences untouched while the rust fence itself picks the grammar up; an over-cap source is refused and `CodeBlock` renders its plain `<pre>`; raising the cap from configuration highlights the same source and the disposer both restores the cap and drops what the wider cap produced; a repeated highlight of a 12,000-character source returns in under a tenth of the cold call's time; the cache evicts to its bound and retains nothing at zero; a settled message parses once across an unmount and remount and produces byte-identical DOM; two different `codeLabels` identities parse separately; the Markdown cache honors its bound and is dropped on reconfiguration; streaming renders never enter it; and hovering one `JsonTree` row performs zero property reads on a sibling subtree's value, observed through a counting `Proxy` (a re-rendered row necessarily re-reads it through `entriesOf` and the recursive preview).

`packages/client/ui-primitives/tests/read-block.client.spec.tsx` pins the per-grammar subscription directly: a ruby load notifies only ruby's source, leaves TypeScript's snapshot unchanged, and never reaches the inert source of an unknown language; and the same language always yields the same source object.

`packages/client/ui-conversation/tests/chat-view.client.spec.tsx` pins the scroll scan: one reader scroll over 64 mounted rows measures at most 8 of them, and the row it records is the first one reaching the scrollport — the same winner the removed full scan produced.

`packages/client/ui-conversation/tests/host.client.spec.ts` pins the config surface: a deployment value reaches the rendering namespace's base layer, an unset deployment publishes an empty section so every built-in stands, and a cap of zero is refused at load.

## Alternatives considered

**Move tokenization to a worker instead of capping it.** The structural fix, and much larger: the worker needs its own bundle entry in every client plugin build, a message protocol for the 2D token runs, and a swap path in both consumers. The cap plus the result cache removes the pathological case today, and the per-grammar load subscription is already the swap channel a worker would reuse, so the worker lands on top of this rather than instead of it. Recorded in both package READMEs as deferred work.

**Bound highlighting by time rather than by size.** shiki's `tokenizeTimeLimit` is per line, not per call, so it cannot bound a 470-line file. A total time budget would need the tokenizer to be interruptible, which the synchronous core is not.

**Cache highlighted HTML by bytes rather than by entry count.** Measuring the retained HTML per entry costs about as much as producing it, and the entry count composes with `maxSourceChars` to give a bound a deployment can reason about directly.

**Key the Markdown cache on text alone and re-bind handlers on read.** Cheaper keys, and it would hand a session's element tree to another session's resolver. The owner identities are what make the cached elements safe to reuse.

**rAF-coalesce `ChatView`'s scroll handler.** The audit's recommendation. Scroll events are already frame-aligned in every modern engine, so the coalescing removes almost no work, while the ownership protocol depends on comparing the delivered position against a ledger written synchronously by every programmatic scroll; deferring the comparison risks attributing a programmatic write to the reader and breaking bottom-follow. Two suites totalling 2,333 lines exist because that protocol is subtle. The O(mounted) fallback was the real cost and is gone.

**Replace the anchor fallback with an `IntersectionObserver`-maintained visible set.** O(visible) instead of O(log n) reads, and it introduces an asynchronous source of truth into a handler that must answer synchronously, plus observer lifecycle against a list that changes on every publication. The binary search needs no state and no new lifecycle.

**Dismiss the `JsonTree` copy affordance on scroll instead of repositioning it.** Cheapest of all and user-visible; it needs the UX owner, not a performance change.

**Virtualize the chat flow** (the audit's F1). Deliberately out of scope: it is a large architectural change against bottom-follow, prepend anchoring and saved-position restoration, and a separate workstream is reducing the transcript payload itself. The settled-Markdown cache above is the prerequisite that note called for — a virtualizer unmounts and remounts rows during scroll, which without the cache converts a one-time open cost into ≈1.3 ms of re-parse per row entering the window.

## Consequences

Highlighting one 20,578-character TSX file falls from 663 ms of blocking work to a 0.004 ms cap check and a plain `<pre>`. A grammar-load storm over 82 real corpus fences falls from 15.5 ms to 0.039 ms — and no longer happens at all for surfaces written in another language. Re-mounting the 205-block corpus falls from 293 ms to 16 ms, which is what react-dom's own string rendering costs in both arms; the parse and element construction are gone. One reader scroll over 64 mounted rows measures 8 boxes instead of 64, and the ratio widens with transcript length.

The user-visible change is that a code surface longer than 10,000 characters renders in plain monospace instead of highlighted. Geometry, copy behavior, line numbering and the read card's gutter are unchanged, because that fallback is the same one an unknown language has always taken. A deployment that wants highlighting on larger surfaces raises `rendering.highlightMaxChars` and accepts the latency the README states.

Settings reads are loopback-only (`SettingsScopeController` runs in `memory` mode for a non-loopback client), so a LAN browser runs on the built-in bounds regardless of cordis.yml. That is a property of the settings transport, not of this change, and the built-ins are the values every deployment gets today.

Retained memory grows by at most `highlightCacheEntries × maxSourceChars` of source plus its HTML, and by `markdownCacheEntries` element trees. Both are bounded by entry count rather than bytes, so a deployment sizing them for very long transcripts is making a memory decision explicitly.

`docs/config-catalog.md` gains the new `ui-conversation` config surface and must be regenerated with the rest of the doc-sync generators.

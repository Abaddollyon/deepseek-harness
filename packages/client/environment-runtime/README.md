---
description: "Browser runtime owner for independent Host contexts, compound Session identity, persistent environment navigation, and generation-bound feature requests."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-environment-runtime

English | [中文](README.zh.md)

## Summary

This package owns the browser shell's local environment identity, persistent environment navigation, compound Host/Session presentation state, and the lifecycle of independently acquired Host runtimes. Each remote runtime receives a fresh Cordis root, an explicit Connection created from its carrier transport, and a dependency-closed domain roster. The selected runtime's presentation plugins receive runtime-owned services while sharing the one renderer, layout, locale, and Slot registry from the shell.

The runtime request service accepts only registered relative `/api/` routes. It binds every call to one environment and rejects completion after the Connection generation changes or disappears. The active composition snapshot keeps the mounted runtime while reporting `connecting`, `connected`, or `disconnected`, records the last connected time, and retries that same Connection without changing navigation. A registry shares concurrent acquisitions of one environment and disposes its runtime and carrier after the last lease releases.

The application shell owns `ctx.environmentNavigation` for its full lifetime. Selecting a Host card in the Environments overview stays on the local control plane; a remote runtime is acquired only when navigation opens one of that Host's Sessions. Shell integrations that must act on the destination use `ctx.environmentComposition.withPresentation(location, callback, { signal })`. It waits for the exact remote presentation and connected generation, or for the restored local shell, passes that destination context and a combined lifetime signal to the callback, and acknowledges the result only while the same navigation intent, runtime, and generation remain current. Its bounded presentation store separates draft, view, detail, scroll, and sidebar state for equal Host-local Session ids. Browser persistence writes the latest state after 250 ms of quiet, flushes pending state on page hide or runtime disposal, ignores storage denial and quota failures, and serializes at most one million UTF-16 code units by retaining the newest Session entries first. The in-memory state remains immediate and keeps older entries omitted from a persisted snapshot. Slot components and Host APIs still receive the native Session id; only renderer Store cache and persistence use the compound identity. UI registration packages may be withdrawn during a Host switch without tearing down navigation or the composition coordinator, and the renderer holds its last root standard sources and scope adapter until their replacements install.

See [Web Client architecture](../../../docs/subsystems/web-client.md) for runtime projection and package ownership.

Shell locations include a Host-qualified blank `new-session` conversation. Explicit workspace actions publish navigation even when the selected Session id is unchanged; `backToSession()` returns to the most recently opened conversation and `canBackToSession()` reports its availability. The shared sidebar query belongs to presentation state. Pin access reads the existing Host workspace view store, with persisted reads for Hosts that have not mounted; it does not serialize another pin set. Pin subscriptions leave with the UI registration, retained presentation sources leave with the shell, and equal Session ids on different Hosts remain independent.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as this package routes browser state and Host requests without assembling model input.

#### KV Cache effect

None; environment selection, presentation state, and transport generations do not change provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One carrier factory owns the shell lifetime** — a product composition cannot replace transport authority while an environment composition is active.
- **Feature routes require explicit registration** — runtime plugins cannot issue arbitrary absolute or unregistered network requests through the environment request service.
- **Presentation memory is bounded to 200 Sessions** — the oldest inactive compound Session state is evicted when the limit is exceeded; the smaller serialized storage cap may retain fewer entries across reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep runtime-owned services below each environment root and keep shell-owned renderer, layout, locale, and navigation services above those roots. A Host switch must retire the old presentation before exposing services from its replacement.

Keep `withPresentation` callbacks short-lived and pass their supplied signal into destination requests. Caller cancellation or deadline, navigation supersession, and composition disposal abort that signal. An operation that ignores it may finish internally, but its result cannot pass the coordinator's final acknowledgement fence.

</details>

**Runtime invariant:** No companion is published. Runtime identity, route authorization, generation fencing, lease disposal, and Loader-owned projection are verified directly by driven lifecycle specs.

---
description: "Browser runtime owner for independent Host contexts, compound Session identity, persistent environment navigation, and generation-bound feature requests."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-environment-runtime

English | [中文](README.zh.md)

## Summary

This package owns the browser shell's local environment identity, persistent environment navigation, compound Host/Session presentation state, and the lifecycle of independently acquired Host runtimes. Each remote runtime receives a fresh Cordis root, an explicit Connection created from its carrier transport, and a dependency-closed domain roster. The selected runtime's presentation plugins receive runtime-owned services while sharing the one renderer, layout, locale, and Slot registry from the shell.

The runtime request service accepts only registered relative `/api/` routes. It binds every call to one environment and rejects completion after the Connection generation changes or disappears. The active composition snapshot keeps the mounted runtime while reporting `connecting`, `connected`, or `disconnected`, records the last connected time, and retries that same Connection without changing navigation. A registry shares concurrent acquisitions of one environment and disposes its runtime and carrier after the last lease releases.

The application shell owns `ctx.environmentNavigation` for its full lifetime. Selecting a Host card in the Environments overview stays on the local control plane; a remote runtime is acquired only when navigation opens one of that Host's Sessions. Its bounded presentation store separates draft, view, detail, scroll, and sidebar state for equal Host-local Session ids. Slot components and Host APIs still receive the native Session id; only renderer Store cache and persistence use the compound identity. UI registration packages may be withdrawn during a Host switch without tearing down navigation or the composition coordinator, and the renderer holds its last root standard sources and scope adapter until their replacements install.

See [Web Client architecture](../../../docs/subsystems/web-client.md) for runtime projection and package ownership.

## Model Experience

None, as this package routes browser state and Host requests without assembling model input.

#### KV Cache effect

None; environment selection, presentation state, and transport generations do not change provider requests.

## Known Limitations and Deferred Work

- **One carrier factory owns the shell lifetime** — a product composition cannot replace transport authority while an environment composition is active.
- **Feature routes require explicit registration** — runtime plugins cannot issue arbitrary absolute or unregistered network requests through the environment request service.
- **Presentation persistence is bounded to 200 Sessions** — the oldest inactive compound Session state is evicted when the limit is exceeded.

**Runtime invariant:** No companion is published. Runtime identity, route authorization, generation fencing, lease disposal, and Loader-owned projection are verified directly by driven lifecycle specs.

---
description: "Environment overview, Activity sidebar switcher, and navigation actions for the persistent web shell."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-environment-navigation

English | [中文](README.zh.md)

## Summary

Users can open the Environments overview from the bottom server action and switch between Workspaces and Activity in the existing sidebar. Each Host retains its own sidebar mode. Expanded controls show both names; the rail provides labeled icons and an explicit selected state. Activity hides workspace-only controls and applies the shared search query to its rows. Selected locations and presentation state survive Host switches and UI remounts. Product plugins supply the environment inventory and Activity rows.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin consumes the persistent `ctx.environmentNavigation` service from `environment-runtime`. Disposal removes only its Slot registrations and subscriptions, preserving the selected location and compound presentation state. Workspaces and Activity controls sit above the existing browsing region, and Activity uses the existing browser body.

The overview renders inside `active.content`, preserving the shared sidebar and renderer. Product packages fill `environment.overview.content` and `sidebar.activity` with environment inventory and activity rows.

See [Web Client architecture](../../../docs/subsystems/web-client.md) for environment runtime projection and [Web Client Slots](../../../docs/subsystems/slots.md) for registration rules.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders browser navigation and registers nothing model-facing.

#### KV Cache effect

None; navigation and sidebar state do not assemble or send provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The package does not discover environments** — a product plugin must fill `environment.overview.content`.
- **The package does not derive Activity rows** — activity providers own the `sidebar.activity` content and its data source.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep environment inventory and activity policy in product packages. This package owns only persistent-shell navigation seats and Host-scoped sidebar state.

</details>

**Runtime invariant:** No companion is published. Slot registration disposal, stable navigation ownership, and Host-scoped sidebar state are verified directly by component and Loader lifecycle specs.

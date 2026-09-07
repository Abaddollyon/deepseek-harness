---
description: "Environment overview, Activity sidebar switcher, and navigation actions for the persistent web shell."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-environment-navigation

English | [中文](README.zh.md)

## Summary

This browser UI plugin renders the Environments overview seat, labeled Workspaces and Activity controls above the existing browsing region, Activity content in the existing browser body, and the bottom server action. It consumes the persistent `ctx.environmentNavigation` service from `environment-runtime`; disposing this plugin removes only its Slot registrations and subscriptions, so the selected location and compound presentation state survive Host switches and UI remounts.

The overview renders inside `active.content`, preserving the shared sidebar and renderer. Product packages fill `environment.overview.content` and `sidebar.activity` with environment inventory and activity rows. Sidebar mode is stored independently for each Host. Expanded controls show both names; the rail exposes separate labeled icons and an explicit selected state. Activity hides workspace-only controls while the shared search query applies to its own rows.

See [Web Client architecture](../../../docs/subsystems/web-client.md) for environment runtime projection and [Web Client Slots](../../../docs/subsystems/slots.md) for registration rules.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

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

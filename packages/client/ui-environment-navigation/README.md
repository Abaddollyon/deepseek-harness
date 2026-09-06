---
description: "Environment overview, Activity sidebar switcher, and navigation actions for the persistent web shell."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-environment-navigation

English | [中文](README.zh.md)

## Summary

This browser UI plugin renders the Environments overview seat, a compact bell toggle in the existing Workspaces header, Activity content in the existing browser body, and the bottom server action. It consumes the persistent `ctx.environmentNavigation` service from `environment-runtime`; disposing this plugin removes only its Slot registrations and subscriptions, so the selected location and compound presentation state survive Host switches and UI remounts.

The overview renders inside `active.content`, preserving the shared sidebar and renderer. Product packages fill `environment.overview.content` and `sidebar.activity` with environment inventory and activity rows. Sidebar mode is stored independently for each Host.

See [Web Client architecture](../../../docs/subsystems/web-client.md) for environment runtime projection and [Web Client Slots](../../../docs/subsystems/slots.md) for registration rules.

## Model Experience

None, as this package renders browser navigation and registers nothing model-facing.

#### KV Cache effect

None; navigation and sidebar state do not assemble or send provider requests.

## Known Limitations and Deferred Work

- **The package does not discover environments** — a product plugin must fill `environment.overview.content`.
- **The package does not derive Activity rows** — activity providers own the `sidebar.activity` content and its data source.

**Runtime invariant:** No companion is published. Slot registration disposal, stable navigation ownership, and Host-scoped sidebar state are verified directly by component and Loader lifecycle specs.

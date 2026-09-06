---
description: "Display-free Host directory browsing seam for in-app clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser

English | [中文](README.zh.md)

## Summary

`dsh-host-directory-browser` defines `ctx.directoryBrowser`, the always-addressable Host capability for bounded directory listing and child-directory creation. It is independent from `ctx.directoryPicker`: a host may keep its native OS chooser for a local window while remote clients browse the same host filesystem without opening host UI.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Provider packages subclass `DirectoryBrowser` and implement `list(path?, signal?)` plus `createDirectory(path, name)`. Consumers inject `directoryBrowser`; the workspace controller exposes it through the `directoryBrowser/list` and `directoryBrowser/createDirectory` Remote methods.

The listing and error value types remain shared with the legacy directory-picker browse capability so existing clients can migrate without a second wire vocabulary.

## Further Exploration

- [Filesystem provider](../directory-browser-filesystem/README.md)
- [Directory-picker seam](../directory-picker/README.md)
- [Workspace controller](../../api/workspace-controller/README.md)

<a id="model-experience"></a>
## Model Experience

None, as the display-free GUI Host browsing seam registers nothing model-facing.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The seam defines no filesystem policy** — bounds, roots, symlink handling, and platform behavior belong to the selected provider.

<a id="dev-note"></a>
### Dev Note

Keep this service independent from the interactive picker. Remote browsing must remain available even when `ctx.directoryPicker` serves a native chooser.

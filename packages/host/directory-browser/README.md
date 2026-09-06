---
description: "Display-free Host directory browsing seam for in-app clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser

English | [中文](README.zh.md)

## Summary

`dsh-host-directory-browser` defines `ctx.directoryBrowser`, the always-addressable Host capability for bounded directory listing and child-directory creation. It is independent from `ctx.directoryPicker`: a host may keep its native OS chooser for a local window while remote clients browse the same host filesystem without opening host UI.

## Use this package

Provider packages subclass `DirectoryBrowser` and implement `list(path?, signal?)` plus `createDirectory(path, name)`. Consumers inject `directoryBrowser`; the workspace controller exposes it through the `directoryBrowser/list` and `directoryBrowser/createDirectory` Remote methods.

The listing and error value types remain shared with the legacy directory-picker browse capability so existing clients can migrate without a second wire vocabulary.

## Further Exploration

- [Filesystem provider](../directory-browser-filesystem/README.md)
- [Directory-picker seam](../directory-picker/README.md)
- [Workspace controller](../../api/workspace-controller/README.md)

## Model Experience

None. The service is a GUI Host capability and exposes no model tools or prompt content.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

This package defines the capability only. Filesystem policy, bounds, and platform behavior belong to the selected provider.

### Dev Note

Keep this service independent from the interactive picker. Remote browsing must remain available even when `ctx.directoryPicker` serves a native chooser.

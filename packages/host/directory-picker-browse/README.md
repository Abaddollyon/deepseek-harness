---
description: "Compatibility adapter exposing the independent Host directory browser as a directory-picker browse capability."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-browse

English | [中文](README.zh.md)

## Summary

`dsh-host-directory-picker-browse` adapts the independent `ctx.directoryBrowser` service to the legacy `ctx.directoryPicker` browse capability. It keeps existing in-app picker surfaces compatible while filesystem ownership lives in the always-available browser provider.

## Use this package

Compose a `directoryBrowser` provider before this adapter. The adapter injects that service and returns a stable `{ kind: 'browse', list, createDirectory }` capability. It has no configuration and performs no filesystem work itself.

Hosts that choose the native picker do not need this adapter for remote browsing: `ctx.directoryBrowser` and the `directoryBrowser/*` Remote namespace stay available independently.

## Further Exploration

- [Directory-browser seam](../directory-browser/README.md)
- [Filesystem provider](../directory-browser-filesystem/README.md)
- [Native picker](../directory-picker-native/README.md)
- [Adaptive picker](../directory-picker-auto/README.md)

## Model Experience

None. This package only adapts GUI Host capabilities.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

The adapter requires exactly one `ctx.directoryBrowser` provider. Its browse contract retains the directory-picker error vocabulary for compatibility.

### Dev Note

Do not move filesystem code back into this adapter. The independent browser is what lets remote clients browse while a local native chooser remains composed.

---
description: "Bounded local-filesystem provider for the display-free Host directory browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser-filesystem

English | [中文](README.zh.md)

## Summary

This package provides `ctx.directoryBrowser` over the Host filesystem. It streams one directory level through a bounded sorted window, follows directory symlinks, skips non-directory rows, and creates one validated child directory without opening operating-system UI.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Compose one row with package name `@deepseek-ai/dsh-host-directory-browser-filesystem`. `list(path?)` defaults to the host account home directory and returns absolute entry paths, ancestry crumbs, hidden flags, and `truncated`. `createDirectory(path, name)` requires a fully qualified parent and one non-blank path segment.

`maxEntries` defaults to 1,000. Relative paths and Windows drive-relative forms are refused rather than resolved against process state. Caller cancellation races every filesystem wait.

## Further Exploration

- [Directory-browser seam](../directory-browser/README.md)
- [Legacy browse adapter](../directory-picker-browse/README.md)
- [Directory-picker architecture decision](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md)

<a id="model-experience"></a>
## Model Experience

None, as the GUI Host filesystem browser registers nothing model-facing.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Platform metadata is limited** — Windows hidden attributes are unavailable through Node dirents, and drive roots are not enumerated.
- **Browsing has whole-filesystem scope** — the Workspace API remains the authority for which selected path becomes a workspace.

<a id="dev-note"></a>
### Dev Note

Keep listing memory bounded and preserve the fully-qualified-path fence. The provider must never invoke an OS chooser.

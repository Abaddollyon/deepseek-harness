---
description: "Bounded local-filesystem provider for the display-free Host directory browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-browser-filesystem

English | [中文](README.zh.md)

## Summary

This package provides `ctx.directoryBrowser` over the Host filesystem. It streams one directory level through a bounded sorted window, follows directory symlinks, skips non-directory rows, and creates one validated child directory without opening operating-system UI.

## Use this package

Compose one row with package name `@deepseek-ai/dsh-host-directory-browser-filesystem`. `list(path?)` defaults to the host account home directory and returns absolute entry paths, ancestry crumbs, hidden flags, and `truncated`. `createDirectory(path, name)` requires a fully qualified parent and one non-blank path segment.

`maxEntries` defaults to 1,000. Relative paths and Windows drive-relative forms are refused rather than resolved against process state. Caller cancellation races every filesystem wait.

## Further Exploration

- [Directory-browser seam](../directory-browser/README.md)
- [Legacy browse adapter](../directory-picker-browse/README.md)
- [Directory-picker architecture decision](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md)

## Model Experience

None. The provider exposes GUI browsing primitives, not model tools.

#### KV Cache effect

None; this package does not assemble provider requests.

## Known Limitations and Deferred Work

Windows hidden attributes are not available through Node dirents, drive roots are not enumerated, and browsing currently has whole-filesystem scope. The Workspace API remains the authority for which selected path becomes a workspace.

### Dev Note

Keep listing memory bounded and preserve the fully-qualified-path fence. The provider must never invoke an OS chooser.

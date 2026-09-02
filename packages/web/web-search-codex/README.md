English | [中文](README.zh.md)

# @deepseek-ai/dsh-web-search-codex

Codex CLI subscription web-search provider for the DSH web seam. Registers fixed `codex` through `ctx.web` and owns one ephemeral app-server process per request.

## Authentication

Sign in with `codex login`. DSH never reads credentials, auth files, keychains, or performs login.

## Configuration

Defaults: `cwd=process.cwd()`, `requestTimeoutMs=60000`, `disposeGraceMs=3000`, `maxResults=8`, `maxPayloadBytes=262144`. Set `executable` to a bare or absolute override. Select with `web.searchProvider: codex`.

## Lifecycle

Each search uses a fresh read-only, approval-free thread. Abort, timeout, and disposal terminate the complete process tree.
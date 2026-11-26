# Agent Note: Client surfaces boot a dependency-closed graph at their own path

Status: implemented

English | [中文](2026-10-02-client-surfaces.zh.md)

## Problem

A small authenticated browser page, such as a desktop companion window, needs the Host's module system and Connection but not the full Web application. The index renderer always publishes the ordinary root graph, and browser authentication exchanges the launch token only on `/`, so such a page either boots every client plugin or cannot sign in at its own URL.

## Decision

[Client Modules](../../../../packages/client/modules/README.md) provides `ctx.clientSurfaces`. A Host plugin registers `{ id, path, rootPlugin, roots }` inside `ctx.effect`; the surface graph is the client-modules bootstrap plus the `inject`/`external` closure of `rootPlugin` and `roots`. Registration fails when the root plugin is part of the ordinary graph or a required `inject` package is not loaded, and the path stops rendering while its closure is incomplete. `dsh.client.defaultRoot: false` keeps a surface-only package out of the ordinary graph unless an ordinary root depends on it; packages without the field keep the ordinary Web boot behavior.

[Frontend Static](../../../../packages/host/frontend-static/README.md) serves a registered path as an index entry: its fallback `auth` selector requires a Peer for the path, so WebServer admits it through Connection like the root, and the render passes the surface id as the `variant` of WebServer's `IndexRenderContext`. Client Modules then injects the surface graph, projected for the rendering Peer's principal like the ordinary graph, while other index rows stay shared. The [token plugin](../../../../packages/host/authentication-token/README.md)'s `webserver/request` listener exchanges the launch token on the root and on each registered surface path; `BrowserAuth.authorizeIndex` accepts the token only on that exact exchange path and redirects to the same clean path. It reads `ctx.clientSurfaces` when the request arrives instead of depending on Client Modules.

A surface graph's rows carry the owner's synced configuration values, read from the ordinary composition's refresh without recomputing them. Its client artifacts are the same combo bundles as the ordinary graph, so their module metadata reaches the renderer, which installs the stylesheets when the closure includes it.

## Alternatives considered

**Let the page filter the ordinary graph in the browser.** Rejected because the omitted packages would still be advertised and fetched, and their startup work would run in the companion.

**Serve the surface page from the extension that owns it.** Rejected because the boot graph, combo responses, and launch-token exchange are private to Client Modules and Connection; an extension would have to duplicate them.

**Accept a caller-supplied return path with the launch token.** Rejected because a caller-controlled redirect widens the authentication boundary; the registered path is the only non-root exchange path.

## Consequences

Any browser page can boot a minimal graph at a registered path through the existing Connection cookie and RPC channels. A surface graph is composed on its first render after the ordinary graph changes, including a change of synced values alone, and its batch responses are served until the next ordinary recomposition replaces that generation. `pluginEvents` frames carry the ordinary graph, so a surface page sees new code and synced values on its next load rather than live. A registration must name every runtime-discovered package in `roots`, because the closure follows only declared `inject` and loaded `external` rows.

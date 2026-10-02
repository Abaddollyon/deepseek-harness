# Agent Note: Client surfaces boot a dependency-closed graph at their own path

Status: implemented

English | [中文](2026-10-02-client-surfaces.zh.md)

## Problem

A small authenticated browser page, such as a desktop companion window, needs the Host's module system and Connection but not the full Web application. The index renderer always publishes the ordinary root graph, and browser authentication exchanges the launch token only on `/`, so such a page either boots every client plugin or cannot sign in at its own URL.

## Decision

[Client Modules](../../../../packages/client/modules/README.md) provides `ctx.clientSurfaces`. A Host plugin registers `{ id, path, rootPlugin, roots }` inside `ctx.effect`; the surface graph is the client-modules bootstrap plus the `inject`/`external` closure of `rootPlugin` and `roots`. Registration fails when the root plugin is part of the ordinary graph or a required `inject` package is not loaded, and the path stops rendering while its closure is incomplete. `dsh.client.defaultRoot: false` keeps a surface-only package out of the ordinary graph unless an ordinary root depends on it; packages without the field keep the ordinary Web boot behavior.

[Frontend Static](../../../../packages/host/frontend-static/README.md) serves a registered path as an index entry. It passes the surface path to Connection's `authorizeIndex`, which accepts the launch token only on that exact path and redirects to the same clean path, and passes the surface id as the `variant` of WebServer's `IndexRenderContext`, so Client Modules injects the surface graph while other index rows stay shared.

## Alternatives considered

**Let the page filter the ordinary graph in the browser.** Rejected because the omitted packages would still be advertised and fetched, and their startup work would run in the companion.

**Serve the surface page from the extension that owns it.** Rejected because the boot graph, combo responses, and launch-token exchange are private to Client Modules and Connection; an extension would have to duplicate them.

**Accept a caller-supplied return path with the launch token.** Rejected because a caller-controlled redirect widens the authentication boundary; the registered path is the only non-root exchange path.

## Consequences

Any browser page can boot a minimal graph at a registered path through the existing Connection cookie and RPC channels. Each surface index render composes its graph again, and its batch responses are served until the next ordinary recomposition replaces that generation. A registration must name every runtime-discovered package in `roots`, because the closure follows only declared `inject` and loaded `external` rows.

# Agent Note: Dedicated RPC channel body limits

Status: implemented

English | [中文](2026-09-05-dedicated-rpc-body-limits.zh.md)

## Problem

Connection's shared HTTP bridge permits request bodies large enough for the Web application's image batches. A dedicated JSON channel carrying small control messages inherited that 300 MiB cap, so its feature could not bound memory consumption without replacing Connection's authenticated RPC route and JSON envelope handling.

## Decision

`HostConnectionRpc.handle()` accepts an optional third argument `{ maxBodyBytes }`. The value is a positive safe integer and the options object contains no other fields. Omission retains `DEFAULT_MAX_REQUEST_BODY_BYTES`, preserving existing registrations.

The dedicated route passes its resolved cap to the existing node:http bridge. The bridge rejects an oversized declared `Content-Length` and also counts chunks while reading a body without that header. Either path returns 413, closes the connection, destroys the incoming request, and avoids Fetch request construction, JSON parsing, and feature-handler dispatch.

## Verification

Host Connection tests register a bounded channel, accept a chunked JSON envelope exactly at its limit, reject a larger chunked envelope before handler dispatch, and reject malformed option objects before route registration. Existing unconfigured channel coverage pins the default call form and effect-owned disposal.

## Alternatives considered

**Lower the shared `/api` limit.** The default cap must hold the configured aggregate image bytes after base64 expansion and envelope overhead. A small control-channel requirement cannot reduce that application-wide capacity.

**Let each feature register a raw Web route.** This duplicates authentication, browser trust, request cancellation, RPC envelope validation, and response encoding in every small channel. The Connection owner already has the correct physical enforcement point.

**Check only `Content-Length`.** Chunked requests can omit the header. Counting bytes during stream consumption enforces the same cap for both request forms.

## Consequences

Small dedicated channels can set a resident-memory bound that matches their protocol while retaining Connection authentication and route disposal. Accepted requests remain fully buffered before dispatch, and shared `/api` interceptors continue to use the application-wide cap because their endpoint owner is selected after the shared body has been read.

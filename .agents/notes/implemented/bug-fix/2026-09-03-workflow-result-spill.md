# Agent Note: Oversized workflow results remain recoverable

Status: implemented

English | [中文](2026-09-03-workflow-result-spill.zh.md)

## Problem

A workflow script returned a 22-item JSON object whose serialization exceeded the tool's default 50,000-character result limit. The tool cut the value mid-string at exactly the limit without a truncation marker, original-length note, or spill path. The durable job record stored the same capped fragment, so the successful result was unrecoverable unless workers had independently written files.

## Decision

The workflow tool serializes a completed return value before projection. When it exceeds `maxResultChars`, the tool stores the exact complete JSON through the session-scoped `ctx.spillStore` and returns `{ truncated: true, originalChars, spillPath, preview }` as the result value. If no spill backend can save an oversized value, the tool fails explicitly rather than presenting a successful but corrupted result.

Supervisor-owned jobs use the same projection before settlement. The local durable jobs registry recognizes that workflow marker and, when its own byte cap is smaller, shortens only `preview` while retaining the original character count and spill reference.

## Alternatives considered

**Keep clipping with a textual suffix.** Rejected because a suffix identifies loss but cannot recover structured data and can itself disappear under a second durable-output cap.

**Persist the full result only in the durable job store.** Rejected because caller-owned workflow runs need the same recovery contract, job-store limits still apply, and the spill service already owns session artifact directory policy and lifecycle.

**Add host wiring or a workflow-specific artifact directory.** Rejected because the owning plugins can consume the existing Cordis spill seam; a second path policy would couple the generic workflow tool to one deployment.

## Verification

The workflow package test returns a structured value above 50,000 characters, verifies every marker field, reads `spillPath`, and compares its bytes with the exact complete pretty-printed JSON. A supervised workflow test verifies the durable record retains the marker and readable reference. Jobs-local tests additionally force a smaller durable byte cap and verify that recovery metadata survives while only the preview shrinks.

## Consequences

Large successful workflow results are recoverable in both foreground and supervised modes, and models are told the contract in the tool description. Oversized completion now depends on a mounted spill backend; missing or failed storage is visible as an error instead of silent data loss. Durable marker metadata receives priority over preview text. This marker+spill contract applies to workflow results (structured JSON); raw stream producers retain the established tail-clipping behavior, whose stream-level truncation metadata remains visible to their callers rather than being mistaken for a workflow result.

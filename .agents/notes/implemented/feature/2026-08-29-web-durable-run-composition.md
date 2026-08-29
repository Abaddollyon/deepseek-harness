# Agent Note: Web profile durable-run composition

Status: implemented

English | [中文](2026-08-29-web-durable-run-composition.zh.md)

## Problem

The durable-run stack (uuid job ids + `ctx.jobStore` + boot reconciliation + supervised workflow ownership) landed as packages, but no shipped composition mounted it: the web bundle still ran the registry in-memory only, so every background job, workflow run, and unread completion notice died with the service — including the self-restart every local deploy performs.

## Decision

`packages/bundle/web-app/cordis.patch.yml` mounts the whole seam host-plane: `storage-sqlite` as backend `sqlite` (one `domains.sqlite` under the DSH home), a `routes: { jobs: sqlite }` override on `storage-domain` (job records update as keyed row writes; JSON whole-file rewrites stay correct for the other domains), `jobs-store-domain` + `run-supervisor` on their defaults, and `persist: true` on the base bundle's `jobs` row. Ownership stays `caller` in the bundle: flipping `tool-workflow` to `supervisor` is a deployment choice made in a profile patch layer, where the load-time guard also demands a nonzero engine `maxRunWallMs`.

## Alternatives considered

- **Route every domain to SQLite** — rejected: existing JSON-backed domains (workspace, feedback, projection cache) hold live local data; switching their medium orphans it for no durability gain, since only the jobs domain needs row-granular writes.
- **Mount `ownership: supervisor` in the bundle** — rejected: the bundle would then have to pick a universal `maxRunWallMs`, which is exactly the kind of deployment-varying tunable the profile layer owns; the load-time guard makes the profile flip safe.
- **A dedicated jobs SQLite file via a second backend row** — rejected: one `domains.sqlite` under the storage hub keeps every domain unit visible to the same backend registry and its version checks; per-domain files add fs sprawl without isolation the schema versioning does not already give.

## Consequences

A web-profile restart now finds every job record it left: resumable ones are re-adopted, the rest settle honestly with exactly one notice per unread completion. The catalogs regenerate with the stack's Config fields. Nothing changes for compositions that do not mount a store — `persist` remains an explicit opt-in.

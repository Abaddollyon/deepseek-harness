# Agent Note: Client duplication ownership

Status: implemented

English | [中文](2026-09-10-client-duplication-ownership.zh.md)

## Problem

Client feed owners, browser storage consumers, navigation flows, and Loader activation paths repeated behavior with different lifecycle and error obligations. Independent copies risked diverging teardown ordering, migration semantics, and cleanup error reporting.

## Decision

`@deepseek-ai/dsh-api-gateway/client` owns the reusable `RemoteFeedLifecycle` for ordered stream disposal, retry-timer cancellation, callback fencing, and teardown failure routing. Session and Workspace feed owners retain their domain-specific readiness, retry admission, and failure publication.

`@deepseek-ai/dsh-client-store` owns `migrateLocalStorageKey`; UI and Session consumers use it for one-shot legacy-key moves without changing best-effort browser-storage failure behavior. Navigation completion and Loader reverse removal remain private helpers in their owning packages because their callbacks and error aggregation are domain-specific.

## Alternatives considered

**Keep duplicate implementations.** Rejected because the detector identified identical lifecycle and cleanup behavior whose ordering obligations must remain aligned.

**Create a broad utility package.** Rejected because Gateway and Client Store already own the relevant runtime seams; a new package would widen dependency topology without another consumer.

**Suppress or evade the detector.** Rejected because it would preserve divergence and provide no behavioral guarantee.

## Consequences

Feed teardown behavior has one implementation and dedicated tests cover stream ordering, timer cancellation, rejected disposal, and owner failure handling. Storage migration has one implementation and tests cover move, destination precedence, and unavailable storage. The focused client suites remain responsible for domain-specific retry and navigation behavior; no snapshot format or model-visible behavior changes.

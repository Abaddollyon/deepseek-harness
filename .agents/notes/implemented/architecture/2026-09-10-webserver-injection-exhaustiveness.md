# Agent Note: Webserver injection rendering invariants

Status: implemented

English | [中文](2026-09-10-webserver-injection-exhaustiveness.zh.md)

## Problem

The structured webserver injection renderer retained a runtime `assertNever` fallback and a conditional body insertion branch that cannot occur under its public types and rendering invariant. Those branches lowered the per-file coverage gate without protecting a reachable product path.

## Decision

`renderRow` switches over the closed `IndexInjection` union without a runtime default. The compiler requires a renderer case whenever a new row kind is added. `renderIndexInjections` always appends `READY_MARKUP` to the body accumulator before insertion, so the body accumulator is necessarily nonempty; it now performs the body-tag insertion or body-less append directly. The body-less append remains covered by the public renderer test, and the body-tag path is exercised through the WebServer render lifecycle.

## Alternatives considered

**Keep the runtime `assertNever`.** Rejected because the union is closed and the compiler is the required change detector; no valid public value can reach the fallback.

**Retain the `body !== ''` guard.** Rejected because `READY_MARKUP` is unconditionally appended immediately before the guard, making the false path impossible while adding no protection.

**Change production only to satisfy coverage.** Rejected; the simplification is accepted only because source-level invariants prove the removed paths unreachable and the README records those invariants.

## Consequences

Unsupported future row kinds fail during compilation rather than at runtime. Body insertion has one unconditional path with the same output for every valid input. Existing body-tag and body-less fragment behavior remains covered by focused tests, and the webserver injection source no longer carries unreachable runtime branches.

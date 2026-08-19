# Agent Note: The code-runtime wall ceiling charges idle time only

Status: implemented

English | [中文](2026-08-19-idle-aware-code-runtime-wall-ceiling.zh.md)

## Problem

The worker-thread code runtime enforced two budgets that disagreed about what a program owes for host work done on its behalf. `computeMs` reads the worker's measured event-loop active time, so a program awaiting a slow binding accrues nothing; `maxWallMs` was a plain `setTimeout` that charged every millisecond, including time the host spent inside a binding the program had called.

That asymmetry killed correct programs. A `run_code` program whose whole body was `await tools.workflow(...)` — one dispatch fanning out seven subagents — accrued no busy time and was still failed at `wall-clock ceiling reached (600000ms)`. Settlement terminates the worker and the run's abort path propagates into the in-flight call, so the same expiry also cancelled the workflow (`workflow run cancelled: workflow signal aborted`) and destroyed the downstream work that had already completed. Every long host dispatch — a workflow, a subagent, a slow build under `bash` — carried the same failure, and raising the number alone would only move it.

## Decision

`maxWallMs` is an idle ceiling: it charges only the stretches of a run with NO host binding dispatch outstanding, which makes it symmetric with `computeMs`. A program waiting on a dispatch is waiting on sanctioned host work, not idling, so neither budget charges it. The remaining purpose is unchanged and is what the ceiling was always for: ending a program that waits on a promise nobody will resolve. Failure identity is unchanged — `kind: 'timeout'` with `wall-clock ceiling reached (${maxWallMs}ms)`.

The host tracks outstanding dispatches in `packages/code-runtime/code-runtime-worker-thread/src/index.ts`. `onCall` begins a dispatch after the duplicate-id check, so a forged repeat id is never counted, and ends it in the per-call `reply` closure ahead of that closure's post-settlement drop. Exactly one `reply` answers each call id by construction: the binding invocation resolves to its reply payload — success, either lossless-JSON refusal, or a throw or reject rendered by the surrounding `catch` — instead of posting from inside its own `try`, and an unknown binding name and lossy arguments each reply once and return. The first outstanding dispatch clears the timer and adds the elapsed stretch to the run's charged idle total; returning to zero re-arms the timer for `maxWallMs` minus that total, so a program alternating short dispatches with idle gaps still expires. Re-arming is skipped once the run has settled, so `finish` remains the last word and leaves no dangling timer. Every re-arm delay is a remainder of `maxWallMs`, which the load-time check bounds by `MAX_TIMER_DELAY_MS`, so no arming path can be clamped to 1 ms.

The default rises from 600_000 to 3_600_000. Under idle-only accounting the value answers a different question — how long a run may sit with nothing outstanding before it is declared stuck — and no longer competes with the duration of legitimate host work. It stays a validated `Config` field with its positivity and `MAX_TIMER_DELAY_MS` checks.

`computeMs` is untouched: it still reads measured busy time, so a hot loop dies whether or not a decoy dispatch is in flight.

## Testing

`packages/code-runtime/code-runtime-worker-thread/tests/runtime.spec.ts` pins the four behaviors that define the ceiling: a program awaiting a binding for 5_000 ms completes under a 2_000 ms ceiling; an idle-forever program with nothing outstanding still fails with `wall-clock ceiling`; a program alternating instant dispatches with 300 ms gaps fails once the gaps total a 1_000 ms ceiling; and a hot loop behind an outstanding dispatch fails on `compute budget` with `computeMs` set above `maxWallMs`. A fifth case overlaps a 1_000 ms and a 5_000 ms dispatch under a 1_500 ms ceiling, which only a count — not a per-dispatch flag — keeps suspended past the early reply.

The idle-forever fixture idles on `new Promise(() => {})` inside the program rather than on a never-resolving binding. A never-resolving binding is an outstanding dispatch, indistinguishable at the host from a slow one, so it no longer describes an idle run.

## Alternatives considered

**Raise `maxWallMs` and keep it unconditional.** The cheapest change and still wrong: it re-prices the bug instead of removing it. Any ceiling below the longest legitimate dispatch kills correct programs, and a ceiling above it stops bounding the idle case it exists for.

**Reset the ceiling on every reply.** Simpler than accumulating charged idle, and unbounded: a program that alternates a one-millisecond dispatch with an idle gap under the ceiling would run forever. Carrying the consumed total forward keeps one budget for the whole run.

**Charge idle time by polling, mirroring the compute budget's sampler.** A second interval timer to reach the same result the dispatch count already provides exactly, plus expiry granularity the ceiling does not need.

**Cap each individual dispatch instead.** A per-dispatch timeout inside the code runtime would duplicate the tool-timeout policy the consumer already owns, and would have to guess a bound for tools whose legitimate durations differ by orders of magnitude.

## Consequences

A program that spends its life inside host dispatches is bounded by the host bindings themselves, by `computeMs` for anything it computes, and by the request's abort signal — not by a clock that cannot see what it is waiting for. The workflow, subagent, and long-build programs that motivated this change complete.

A host binding that never settles now holds its run open: the ceiling stays suspended while the dispatch is outstanding, and the run ends only through the request's abort signal or runtime disposal. Bounding one dispatch belongs to the consumer that owns the binding; the package README records the gap.

The ceiling stops being a general-purpose run timeout, which callers that wanted a total-elapsed bound must now request through their own signal. Containment is unchanged: every settlement path still terminates the worker, the output ledger is untouched, and a hostile peer can neither double-count nor leak a dispatch, because ids are counted at most once and each answered id produces exactly one reply.

The [Code Mode Agent Note](../feature/2026-06-15-code-mode.md) owns the two-budget decision and carries the corrected `maxWallMs` semantics.

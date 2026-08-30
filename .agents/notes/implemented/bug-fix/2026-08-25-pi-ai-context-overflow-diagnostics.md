# Agent Note: Surface resolved capacity and usage in pi-ai context-overflow errors

Status: implemented

English | [中文](2026-08-25-pi-ai-context-overflow-diagnostics.zh.md)

## Problem

When pi-ai's `isContextOverflow` detects a usage-based overflow with no provider error wording — a `stop` whose input plus cache-read usage exceeds the resolved context window, or a zero-output `length` stop that fills it — `mapStopReason` in `dsh-llm-pi-ai` fabricated a generic local message: `pi-ai detected context overflow for model "<model>"`. The adapter already resolves and passes the catalog context window into mapping, and the usage that tripped the detector is on the message, yet neither reached the reader. The user was told *that* an overflow happened but not the capacity or the consumption, so the message gave no starting point for action.

This behavior existed before as part of the `apply-rc6-context-overflow-diagnostics` compiled-bundle patch and was silently dropped when compiled patching was retired in the upstream 0.1.1-rc.2 upgrade. This note records re-landing the pi-ai overflow half of that patch in source.

## Decision

The local fallback message now names the resolved capacity and the usage that tripped it: `pi-ai detected context overflow for model "<model>" at resolved context window <N> tokens (input <I>, cache-read <C>)`. Provider-supplied overflow text still wins verbatim (`message.errorMessage`), because it carries the provider's own numbers.

The interpolated values need no `unknown` fallbacks, and adding them would be dead code: on the fallback path `message.errorMessage` is absent, and pi-ai's detector only fires without error wording for the two usage-versus-window cases, both of which require a resolved `contextWindow`; `usage` is a required field on pi-ai's `AssistantMessage`. An unreachable fallback branch would also fail the per-file 100% coverage gate on `packages/*/*/src`.

The message interpolates only the model id and integer counts — never request or response content — so the diagnostic cannot leak prompt payload or credentials. The focused expectations in `convert.spec.ts` and the catalog-window adapter test in `adapter.spec.ts` pin the new wording, including a length-stop case whose cache-read share is visible in the message and a boundary case whose at-window usage stays a successful stop. The authored `context-overflow-diagnostic` session snapshot replays a turn that ends on the actionable error finish — the failed compaction recovery retaining the original failure — and proves the diagnostic persists to the session log and the headless stderr projection.

## Alternatives considered

**Report the summed input-plus-cache-read figure the detector compares against the window.** Rejected: the separate fields state what was measured without hiding the composition; a reader reducing usage needs to know which bucket dominates.

**Add `?? "unknown"` fallbacks for every interpolated field, mirroring the historical compiled patch.** Rejected: the patch patched compiled JavaScript where types were erased; in source the fallback path provably always has a resolved window and a populated `usage`, and the extra branches would be unreachable and fail coverage.

**Leave the generic message and rely on the subsequent compaction to explain itself.** Rejected: the overflow error is the first and sometimes only diagnostic the user sees; compaction runs later and cannot retroactively make the original failure actionable.

## Consequences

- A local overflow error now carries the numbers needed to act (reduce input, clear cache-heavy history, or pick a larger-window model) without reproducing the turn.
- The message is longer but remains a single factual sentence; provider-worded overflow errors are untouched.
- The wording is pinned by conversion and adapter tests, so a future upstream upgrade that regenerates the mapping cannot silently revert it to the generic text without failing tests.

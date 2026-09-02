# Agent Note: Retain complete marker framing in the pwsh fallback budget

Status: implemented

English | [中文](2026-08-30-pwsh-fallback-marker-framing.zh.md)

## Problem

The persistent pwsh tool accumulates an incremental fallback buffer so partial diagnostics survive when the retained scrollback cannot answer: a lost START marker, a torn read, or a shell that exited mid-capture. The cap bounding that buffer was sized as `maxOutputChars` plus one printable prompt once the echoed wrapper had been normalized out of the buffer. That budget ignored the framing it exists to protect. The real START marker alone is 66 characters, and a polling delta can also carry the prompt function's OSC 133;D emission on either side of the wrapped command, so a small `maxOutputChars` let size capping cut the real START marker before `partialOutput` ran. Extraction then missed a marker it had actually observed, leaked the truncated marker fragment into the model-facing result, and reported the beginning of the output as dropped when it was not. The raw budget had the same class of flaw: a wrapped echo carries terminal-inserted line breaks, so the echo can exceed the wrapper length the budget reserved. The regression added with the cap exercised only a marker-free fallback, so the real marker-dependent path was never forced.

## Decision

The normalized budget retains the complete marker framing around the output budget: both prompt emissions a delta can carry (the OSC sequence with its 32-bit status plus the printable prompt), the real START marker, the END marker, and its status digits, plus line-break slack. Before the real START marker arrives, retention keeps the stream head so a marker split across polling deltas can still arrive. Once the marker is observed, retention starts at that marker and keeps only the bounded suffix, so size capping cannot cut the real START marker before `partialOutput`. The raw budget adds the echoed wrapper at the degenerate one-column width, which doubles the wrapper with physical line breaks, so a not-yet-normalized echo cannot push the real marker past the cap either. The complete retained diagnostic stays bounded at twice the wrapper plus `maxOutputChars` plus fixed framing.

The regression forces the real marker-dependent fallback instead of a synthetic helper: a stub backend whose incremental delta carries the wrapped echo, the real START marker, and partial output while the scrollback retains none of it. PowerShell is unavailable on the development machines, so the pin lives in the keyless unit suite and the real-shell composition suite remains owned by platform CI.

## Alternatives considered

**Drop the cap like the bash mirror.** Rejected: an unechoed stream, or one whose echo never normalizes, would grow the buffer without bound for the whole command; the complete retained diagnostic must stay bounded.

**Trim around the marker instead of capping at the buffer head.** Rejected: marker-aware trimming has to special-case the not-yet-arrived echo, the absent marker, and the echoed marker copy inside the wrapper, while a framing-complete constant budget states one bound and covers every case.

**Keep the marker-free regression.** Rejected: it passed against the truncating implementation because its assertions held on both the broken and the repaired path; only a fallback that anchors on the real START marker fails when the cap cuts the marker.

## Verification

`packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` anchors partial diagnostics on the real START marker behind a wrapped echo with a tiny output cap, asserts that no marker fragment or false lost-prefix notice leaks, and bounds the rendered result when partial output overflows the cap. The package reports exact 100% statement, branch, function, and line coverage; the pwsh-dependent real-shell composition suite self-skips locally and stays with platform CI.

## Consequences

Partial and timeout diagnostics retain real command output instead of marker fragments whenever the marker was observed, and in-budget commands no longer risk a false clipped notice from cut END framing. The fallback buffer grows from `maxOutputChars` plus one prompt to twice the wrapper plus `maxOutputChars` plus fixed framing — still fully bounded, now by construction rather than by assumption about what a delta contains.

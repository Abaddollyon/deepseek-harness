# Agent Note: Remove the PSReadLine echo instead of stripping it

Status: proposed

English | [中文](2026-08-25-pwsh-echo-free-capture.zh.md)

## Problem

`tool-pwsh-persistent` drives a real PTY: it submits a command and reads the screen back. PowerShell's line editor, PSReadLine, renders submitted input back into that stream, so the screen carries the wrapper twice — once as the echo of the input, once as the real output. Capture is marker-anchored and then strips the echo by matching the wrapper source.

That strip holds only while the echoed wrapper occupies one physical line, which `wrapCommand` states as its invariant: "Keep the wrapper on one physical line: PSReadLine renders the echoed input, and a wrapped line would split the echo the extraction strips."

The invariant does not hold. The wrapper measures 412 characters for a short command, while `terminal-bash` opens the PTY at its configured 160 columns, so the echo spans three physical lines. The terminal's line breaks defeat the strip, the anchor lands inside the echo rather than the output, and capture yields nothing. CI showed the result directly: an assertion received the command text `'"console=" + [Console]::OutputEncoding…'` where its output belonged.

Widening the terminal cannot fix this, because the model's own command is embedded in the wrapper: any fixed width is exceeded by a long enough command. The current behaviour is not a width that is slightly too small; it is a bound that cannot be guaranteed.

The failure stayed invisible through three separate concealments: the real-shell cases skip wherever `pwsh` is absent, which includes the machines this suite is usually run on; upstream exercises them on self-hosted Windows runners; and this fork had no CI executing at all until a hosted gate was added. The Linux path appears never to have worked. A separate fix already stopped the empty capture being reported as clipped output, so the current failure is an honest timeout rather than a false result, but the command still does not run.

## Proposal

Remove PSReadLine from the session at shell initialization, so no echo is produced. Capture then reads the text between its own markers with nothing to strip, and the one-physical-line invariant disappears along with the machinery defending it: the wrapper-source strip, the partial-echo handling in the fallback path, and the width sensitivity that makes long commands unsafe.

The package README currently records the echo as unavoidable: "Input echo is unavoidable: PowerShell's PSReadLine renders submitted input back into the terminal stream, and there is no `stty -echo` equivalent." Removing the module is that equivalent. PSReadLine is an interactive line editor; a programmatic shell has no use for command-line editing, history search, or syntax highlighting.

## Alternatives considered

**Widen the PTY for pwsh sessions.** Rejected. It restores the invariant only for short commands. Because the model's command is embedded in the wrapper, a sufficiently long command still wraps, converting a consistent failure into an intermittent one — the worse of the two, because it would pass the tests that motivated the change.

**Shorten the wrapper.** Rejected for the same reason: it buys headroom without establishing a bound.

**Make the extraction tolerate a wrapped echo.** Rejected as the primary route. It adds terminal-width reasoning to a parser that currently needs none, and it keeps the echo-handling layer this proposal removes. Worth revisiting only if PSReadLine cannot be removed.

**Restrict the tool to Windows and skip elsewhere.** Rejected: the README already documents POSIX pwsh as supported, and a skip would encode a defect as a platform boundary.

## Acceptance criteria

The proposal is unproven until these hold, in this order:

1. A session with PSReadLine removed starts and executes commands, and the read stream contains no echo of submitted input.
2. The mock-backed suite in `packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` passes with the echo-handling paths removed, or each removed case is deleted with its reason recorded.
3. The real-shell cases — `tests/loader-composition.spec.ts` and `packages/terminal/terminal-bash/tests/local.spec.ts` — pass with `pwsh` present, including the UTF-8 encoding case.
4. The hosted fork CI gate passes, since it is the environment that exposed the defect. A local pass alone is not evidence: these cases skip where `pwsh` is absent.

## Risks

The proposal rests on an assumption that has not been measured: that removing PSReadLine suppresses the echo at all. If PowerShell renders submitted input without it, the premise fails and the fallback is to make extraction tolerate a wrapped echo, keeping the layer this proposal removes.

Three unknowns must be settled by measurement rather than judgement. Whether `Remove-Module PSReadLine` is sufficient or the shell must start without loading it. Whether the readiness marker survives, since the package already records that a model redefining `prompt` removes it and drops the shell onto a slower silence tier. Whether `terminal-bash`'s pwsh dialect performs its own PSReadLine setup that must change in step.

Removing the echo-handling paths deletes their tests. Each deletion is a claim that the case can no longer occur; a case removed because it is inconvenient rather than impossible would hide a regression that the current tests would have caught.

The change alters a shipped tool's runtime behaviour on Windows, where the path currently works, while being motivated by Linux, where it does not. Windows has no local coverage here and upstream's self-hosted runners are unavailable to this fork, so a Windows regression would not be observed before merge.

## Consequences

PowerShell support would work where the README already claims it does, and long commands would stop being a hidden width hazard. The package would carry less code rather than more, and one documented limitation would be retired rather than worked around. The hosted CI gate would go green on evidence instead of exclusion.

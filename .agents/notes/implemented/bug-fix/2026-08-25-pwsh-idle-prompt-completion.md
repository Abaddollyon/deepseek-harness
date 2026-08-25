# Agent Note: An idle pwsh prompt is not command completion

Status: implemented

English | [中文](2026-08-25-pwsh-idle-prompt-completion.zh.md)

## Problem

The persistent pwsh tool polls the PTY and accepts an idle shell prompt as proof that the command finished. That inference is wrong at one moment: a freshly started shell is also sitting at an idle prompt before it has echoed anything of the command just sent. Reaching `promptCompleted` in that window produced a capture with no text and `incomplete: true`, which `maybeTruncate` renders as the clipped-output notice alone. The model was told its result had been truncated when no output existed to truncate, and the notice it received advises searching a file with `Select-String` — advice that means nothing for arbitrary command output.

The race needs a slow start, so it never appeared on a developer machine. It also never appeared in local test runs for a simpler reason: the cases that exercise a real shell skip unless `pwsh` is installed, and it is not installed on the machines where this suite is usually run. The hosted fork CI gate, which runs on an image that ships PowerShell, failed on its first execution.

## Decision

An idle prompt is accepted as completion only when the capture has something to report: non-empty text, or a capture already marked complete. Empty-and-incomplete keeps polling, and the existing command deadline remains the bound, so a shell that truly never answers still fails as a timeout rather than as a false result.

The prompt fallback itself is kept. It is the path that reports a result whose prefix scrolled out of the retained buffer, where the start marker is genuinely absent but real output exists; that case carries text and is unaffected. Requiring the start marker instead would have deleted that fallback — it breaks the missing-prefix and exhausted-scrollback cases, which is how the boundary between the two situations was located.

## Alternatives considered

**Wait for the completion marker and drop the prompt fallback.** Rejected: the fallback exists for captures whose start marker has left the retained buffer. Removing it converts those results into deadline timeouts, which the package's own missing-prefix and exhausted-scrollback cases demonstrate.

**Require the start marker before accepting an idle prompt.** Rejected for the same reason, and confirmed by running the suite: two mock-backed cases that assert the fallback hang until the test deadline.

**Raise the poll delay or the command deadline.** Rejected: both hide the race behind timing rather than removing it, and neither makes an empty capture a truthful result.

## Verification

`packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` covers the boundary with mock backends: the missing-prefix, exhausted-scrollback and prompt-fallback cases still complete through the fallback, while the startup window no longer renders an empty capture as clipped output.

## Consequences

A model driving the persistent shell no longer receives a truncation notice for output that was never produced, so it stops following that notice's file-search advice down a path that cannot help. A shell that genuinely produces nothing now reaches its deadline and reports a timeout, which states the real condition.

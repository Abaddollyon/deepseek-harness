# Agent Note: Tolerate wrapped PowerShell input echo

Status: implemented

English | [中文](2026-08-25-pwsh-echo-free-capture.zh.md)

## Problem

`tool-pwsh-persistent` submits a marker-bearing wrapper through a real PTY. PowerShell's interactive line editor renders that input back into the terminal stream before the wrapper emits its real START marker, command output, and END status. A short wrapper is already longer than the configured 160-column terminal, and the embedded model command makes every fixed width insufficient. Terminal-inserted physical line breaks therefore prevent an exact one-line wrapper replacement and can make an echoed marker look like command progress.

A direct PTY experiment rejected the assumption that removing PSReadLine eliminates this echo. `Remove-Module PSReadLine` made `Get-Module PSReadLine` return false, but later input was still rendered. Starting with `-NonInteractive`, including a startup command that found no PSReadLine module to remove, also rendered submitted input. PowerShell's host line reader remains interactive without the module, so echo handling is required.

The real shell exposed two related readiness faults. The pwsh backend submitted its encoding and prompt bootstrap before the native prompt was ready, and an early silence settlement could submit that bootstrap again because an empty viewport was also used as the "first send" flag. The echoed bootstrap contains the controlled prompt literal, so a substring search could accept source text as readiness. A non-empty later send could likewise inherit silence from historical scrollback before that write produced any output.

## Decision

Capture removes at most one exact submitted wrapper while tolerating only `\n` characters between its source characters. The matcher builds a newline-free projection with raw offsets, finds the exact wrapper in that projection, and removes the corresponding raw span from the original text. Real command-output line breaks remain unchanged. Complete marker extraction and snapshot and incremental fallback extraction all operate on the cleaned text. A wrapper clipped before capture remains unmatched and the result remains explicitly incomplete rather than guessing at a fragment.

Prompt fallback uses operation-scoped send output instead of substituting the terminal's historical viewport when a send produced no delta. A readiness result containing command markers from another nonce is stale and cannot finish the current command. A wrapped current echo followed by stale readiness cleans to an empty incomplete capture, so polling continues until current marker or diagnostic evidence arrives. Redefining `prompt` still removes the owned marker and uses the existing slower silence tier.

The pwsh terminal dialect first waits for PowerShell's native prompt, sends the UTF-8 and controlled-prompt bootstrap exactly once, and uses output-free follow-up sends until the controlled prompt is actually at the retained output tail. The line-oriented PTY answers cursor-position queries with a stable origin so PowerShell's line editor can finish rendering without a screen model. Silence can settle a non-empty write only after that send has produced output; empty observation sends may still use silence while waiting for delayed prompt output.

Unit coverage retains the one-line echo case and adds physically wrapped echo, wrapped prompt fallback, echo-only stale readiness, foreign-nonce readiness, split cursor-query, one-shot bootstrap, and current-send readiness cases. Real-shell coverage exercises persistent state and UTF-8 output with pwsh present.

## Alternatives considered

**Remove PSReadLine after startup.** Rejected by direct PTY evidence: unloading the module does not remove the host's input rendering.

**Start PowerShell without PSReadLine.** Rejected because `-NonInteractive` and a startup path with no loaded PSReadLine module still render submitted input in a PTY.

**Increase the terminal width.** Rejected because the wrapper contains the model command, so no finite width can prevent every wrap.

**Collapse all line breaks before extraction.** Rejected because command output owns its line structure. Only an exact nonce-bearing wrapper match may ignore physical line breaks, and the returned text remains the original stream with that one raw span removed.

**Accept any controlled-prompt substring during bootstrap.** Rejected because the submitted prompt-function source contains that literal before PowerShell executes it.

## Consequences

Persistent PowerShell commands are independent of terminal width, and delayed line-editor rendering cannot cause a second bootstrap or let prior-command markers finish a new command. Input echo remains a documented platform fact rather than a removable limitation. If bounded scrollback drops part of the echoed wrapper, an incomplete result may retain the unmatched fragment and reports clipping. The PTY still provides line-oriented output rather than full terminal emulation; its cursor response exists only to satisfy interactive line readers.

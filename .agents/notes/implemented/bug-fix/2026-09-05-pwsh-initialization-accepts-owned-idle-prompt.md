# Agent Note: Pwsh initialization accepts its owned idle prompt

Status: implemented

English | [中文](2026-09-05-pwsh-initialization-accepts-owned-idle-prompt.zh.md)

## Problem

The persistent pwsh tool replaces the terminal backend's prompt with its own private prompt after the backend has already completed startup. The tool's second initialization stage then required `stdin_read` even though the default Windows backend cannot observe that state. Its exact readiness check still expected the backend prompt, so the replacement prompt settled as `inferred_idle`; the tool kept polling until the command-wide deadline and never dispatched the first command.

The tool already recognizes its exact prompt tail through `promptCompleted`. Arbitrary `inferred_idle` output remains insufficient because silence does not prove that the prompt override executed.

## Decision

The second initialization stage accepts either `stdin_read` or `inferred_idle` accompanied by the exact tool-owned prompt tail. An inferred-idle viewport without that prompt keeps polling under the existing deadline. Session exit and terminal timeout remain initialization failures, and cancellation or failure still closes the unusable shell.

The terminal backend keeps its own strict startup check before publishing the spawned session. This decision applies only after the tool submits its prompt override; it does not weaken backend startup or command completion framing.

## Alternatives considered

**Accept every `inferred_idle` initialization result.** Rejected because output silence can occur before the prompt override executes and would permit premature command dispatch.

**Keep requiring `stdin_read`.** Rejected because native Windows cannot provide that observation for the tool-owned prompt, so the first command consumes the full deadline.

**Remove the tool-owned prompt or import the backend prompt.** Rejected because command fallback and prompt stripping currently depend on the private prompt, while importing one provider's prompt would couple the tool to that provider.

**Increase the initialization deadline.** Rejected because it only extends a deterministic wait for evidence that the Windows backend cannot produce.

## Verification

The package regression covers an inferred-idle viewport with the exact owned prompt, rejects inferred idle with only the previous backend prompt, and delays first-command dispatch until a later poll presents the owned prompt. Existing exit, timeout, cancellation, failure, and disposal cases retain shell cleanup coverage.

## Consequences

Native Windows can complete the tool-owned prompt transition without waiting for the command deadline. Providers that report exact stdin reads retain their existing path, while providers that report inferred idle must present the exact prompt installed by this tool. Native Windows installed-wheel acceptance remains required because deterministic stubs do not exercise ConPTY or the packaged runtime.

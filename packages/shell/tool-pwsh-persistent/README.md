---
description: "The model-facing persistent pwsh tool for users and maintainers choosing, configuring, or debugging owner-scoped PowerShell shell state that survives across calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-pwsh-persistent

English | [中文](README.zh.md)

## Summary


dsh-tool-pwsh-persistent gives the agent a pwsh tool whose shell state persists across calls for the owning agent: cwd, exported environment variables, functions, and background jobs survive between commands. Each agent gets its own owner-scoped PTY session from the terminal service, and commands for the same agent run one at a time. Configuration selects the terminal backend, deadline, output cap, and model-facing description. A timeout, explicit exit, or failed send closes the shell, and the next call starts fresh. Mount it with a terminal backend such as terminal-bash configured with shellDialect: pwsh and the ctx.terminals service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin where an agent needs PowerShell state between commands, such as a Windows build session or a script that exports variables for later steps. It registers the pwsh tool and requires the ctx.tools and ctx.terminals services plus an owning agent session at execution time.

### When to choose it

Choose the persistent tool when work depends on cross-call state. Choose a one-shot shell tool when each command should start from a clean environment. Commands needing interactive stdin are unsupported: a foreground command that reads input blocks until the readiness timeout, which resets the shell.

### Minimal configuration

The default shell backend uses terminal-bash with the pwsh dialect; deployments may register another terminal backend and select it by name.

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellDialect: pwsh
- name: '@deepseek-ai/dsh-tool-pwsh-persistent'
  config:
    backendType: shell
```

| Field | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Registered terminal backend used for each agent shell |
| `timeoutMs` | `300,000` | Wall-clock limit for one command; timeout closes the shell |
| `maxOutputChars` | `16,000` | Maximum retained command-output characters; fixed diagnostics are added afterward |
| `description` | Persistent-shell description | Model-facing environment contract |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-pwsh-persistent) is the exhaustive source for accepted fields and their JSDoc.

### What the agent can rely on

Commands share one shell per agent, so cwd, `$env:` variables, functions, and background jobs persist across calls. Results exclude private completion markers, the shell prompt, and echoed input. Nonzero commands append `[exit code: N]`; a shell that exits before reporting status appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]`, then resets. Long output keeps the earliest retained prefix plus a clipping notice; if terminal scrollback has dropped that prefix, the result says so explicitly. Timeout returns bounded partial output, closes the uncertain shell, and reports the reset.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin creates one owner-scoped shell lazily, wraps each command with unique START and END markers carrying the exit status, polls scrollback in 1,000-line pages, and extracts the span between the real markers. PowerShell line-editor echo is removed by matching the exact wrapper source while tolerating terminal-inserted physical line breaks. If scrollback cannot answer, the incremental fallback retains complete marker framing and anchors at an observed START marker before bounding partial output; the fallback remains bounded by the wrapper and output cap. A timeout or uncertain shell state resets the owner shell.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: shell registry, command wrapping, fallback retention, scrollback polling, extraction, and rendering |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; shell reuse is observable through tool execution) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [terminal package map](../../terminal/README.md) — persistent PTY capability family.
- [terminal seam](../../terminal/terminal/README.md) — the ctx.terminals service behind the tool.
- [terminal-bash backend](../../terminal/terminal-bash/README.md) — the default backend and pwsh dialect provider.
- [tool-terminal](../../terminal/tool-terminal/README.md) — model-facing terminal tools for interactive work.
- [Persistent PTY sessions Agent Note](../../../.agents/notes/implemented/architecture/2026-08-11-pwsh-persistent-pty.md) — owner-scoped session design and rationale.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh-persistent) — exact pwsh argument schema.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-pwsh-persistent) — accepted config fields and source declarations.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh-persistent), including the configured `description`. The plugin contributes no standalone system-prompt section; the deployment owns persona and environment guidance.

#### Token effect

Fixed schema cost while `pwsh` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Commands share one shell per Agent, so cwd, `$env:` variables, functions, and background jobs persist across calls. Results exclude private completion markers, the shell prompt, and echoed input (PSReadLine renders submitted input into the stream; marker-anchored extraction and exact wrapper matching remove it). A nonzero wrapped command appends `[exit code: N]`; native commands retain their native exit code and terminating PowerShell errors use 1. A shell that exits before status reporting appends a shell-exit status and resets. Long output preserves the earliest retained prefix with a clipping notice; if scrollback has dropped that prefix, the result says so explicitly. Timeout returns bounded partial output, closes the uncertain shell, and reports the reset.

#### Token effect

Data-dependent. `maxOutputChars` bounds retained command output; fixed clipping, lost-prefix, status, timeout, and reset diagnostics can extend the result.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tool requires an owning Agent and a real terminal backend with a pwsh dialect (Windows ConPTY or POSIX pwsh).
- **Input echo is unavoidable**: PowerShell's line editor renders submitted input into the terminal stream, and removing PSReadLine does not suppress it. Marker-anchored extraction excludes the echo in complete results, and fallback matching spans physical line breaks. If scrollback clips part of the wrapper before capture, an unmatched fragment can remain in an incomplete result; retained fallback includes fixed marker framing and stays bounded by wrapper length and `maxOutputChars`.
- Raw ESC characters inside model commands are unsupported: PSReadLine consumes them before execution. The wrapper escapes the control bytes it needs, including OSC markers built from `[char]27` and body backtick escapes.
- A model redefinition of `prompt` removes the readiness marker; the shell settles through the printable prompt or silence tier.
- There is no interactive stdin during a command; a foreground command that reads input blocks until the readiness timeout, which resets the shell.
- SIGTSTP/SIGHUP are unavailable on Windows; SIGINT is delivered as console-wide Ctrl-C input, which cancels a pending prompt line instead of signalling a process.
- Under the Windows ACL sandbox's read-only mode, pwsh starts in ConstrainedLanguage, which may deny the bootstrap's Console encoding pin and prompt marker. Commands can still settle through the printable prompt and silence tier, but non-ASCII output may follow the host code page.
- The BEL-terminated OSC marker remains a readiness signal only; a BEL event channel to the model remains deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

PowerShell-dependent composition tests self-skip when pwsh is unavailable. Keyless unit fixtures cover marker extraction, wrapped echo, readiness fallback, bounded partial output, shell exit, timeout, and lifecycle disposal.

</details>

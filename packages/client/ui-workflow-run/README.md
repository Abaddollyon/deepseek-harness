---
description: "Durable workflow-run Conversation Node for the dsh web client: reconstructs workflow runs as independent chat nodes with nested member disclosure."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workflow-run

English | [中文](README.zh.md)

## Summary

Use `dsh-client-ui-workflow-run` to inspect durable workflow runs as independent Chat nodes. Expand runs for phases and phases for members; running, failed, cancelled, and interrupted levels open by default, while completed levels remain closed. Members can open child Sessions while the ordinary Session list identifies them as children of the current Session, including after settlement. The projection retains phase titles and durable narration, but the panel displays only names, member counts, and statuses. Choose it for progress and child navigation, not scripts, outputs, errors, logs, usage, static topology, or execution controls.

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

A workflow run recorded through `dsh-tool-workflow` appears in the conversation as its own node: expand the run to see its phases, and expand a phase to see its members. The Definition does not exclude runs with a `parentCallId`. Distinct recorded phase titles seed groups in first-seen order, including phases with no members; member starts then add any missing phase groups in member order. Omitted and empty phase identities stay distinct, and settlement changes status without removing or reordering members. A member opens its child Session whenever the child id is in the ordinary Session list with `origin: 'subagent'` and `parentId` equal to the current Session. Settlement does not revoke this: completed and interrupted members stay openable while their child row exists, because `sessions.open(id)` works on a finished child. Underlined member text is the only visible navigation affordance; keyboard focus draws a two-pixel business-primary ring around the name area, while the status copy remains the lifecycle word. The component calls only the injected ordinary `sessions.open(id)` action; rows whose child Session is absent from the ordinary list — remote, addressed-only, or wrong-parent — remain non-interactive.

### Navigating the node

The run uses a 32-pixel row with persistent chevrons, an inline state dot, and status text; phases use disclosure rows with title and member count in the main area and a fixed aggregate-status tail; members use a 16-pixel dot slot, a truncating name area, and a fixed status column. Opening a member's child Session requires the child id to be in the ordinary Session list, the row to have `origin: 'subagent'`, and its `parentId` to be the current Session — remote, addressed-only, wrong-parent, or absent rows remain non-interactive; settlement does not revoke navigation while the child row exists.

### State and completion

Completion updates the visible status immediately but delays its automatic close while focus remains inside the content. A closed Turn or Step with missing terminal events presents the affected run or members as interrupted without changing the tool result. A detached run remains running after its starting Step closes because the supervisor owns its later terminal event.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node is a deterministic replay of six durable `tool-workflow/*` event types: `run-start` creates one Context keyed by `runId`; `phase`, `log`, `agent-start`, `agent-end`, and `run-end` update it in log order. A workflow `run/detached` with a `runId` also updates that Context. Phase titles seed groups; logs retain `message`, `ordinal`, and optional `truncated` in the projected `narration` array, which is omitted for older records without captured logs. `WorkflowRunPanel` does not render that narration. A history tail containing only updates remains pending until an older page supplies the unique start, after which prepend, complete replay, and live append produce the same state.

### Disclosure choices

Ordinary running updates preserve the current choice, the first abnormal edge opens once, normal completion closes once, and a completed phase plus the outer run open again when a new running member starts under the same phase key. If an entire new clean cycle arrives in one render while the run remains active, the phase finishes folded but the outer run opens once to expose its updated summary. `WorkflowRunPanel` owns the phase choices, so closing and reopening the outer run does not reset them; a renderer remount reconstructs every initial choice from durable facts.

### Composition

The package registers its Definition, locale dictionary, and `workflow-run` renderer as Cordis effects; removing the client entry retracts all three contributions. The shipped Web bundle includes the plugin after `ui-conversation` and `ui-tool`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the tool seam, the conversation host, and the tool presentation layer.

- [tool-workflow](../../workflow/tool-workflow/README.md) — the tool that owns the six `tool-workflow/*` Session event types folded here.
- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the `conversation.chat.node` slot.
- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer this node sits beside.
- [Conversation subsystem](../../../docs/subsystems/conversation.md) — how a business-owned feature registers a Conversation node.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that renders durable workflow records without changing model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define which runs produce records and what the node exposes; they are current package constraints.

- **Durable workflow records are required** — the Definition accepts recorded runs without filtering `parentCallId`, but cannot reconstruct executions that emit no matching `tool-workflow/*` events; updates alone produce no visible node until the matching `run-start` is available.
- **Navigation follows the ordinary Session list** — a member stays openable after settlement while its child row is listed, but a member whose child Session the list does not contain (for example a remote row) never exposes an opener from this node.
- **The panel shows names, member counts, and statuses** — durable narration is retained in the node payload but not displayed; scripts, outputs, error details, usage, static topology, and execution controls also remain outside the panel.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The browser plugin contributes one effect-owned Conversation Definition, keyed renderer, and dictionary; tests prove their disposal and the Host tool package owns the durable event invariant.

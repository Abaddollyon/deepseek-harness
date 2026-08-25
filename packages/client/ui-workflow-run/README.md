# @deepseek-ai/dsh-client-ui-workflow-run

English | [中文](README.zh.md)

The browser plugin that reconstructs durable top-level workflow runs as independent Chat nodes. It consumes the four `tool-workflow/*` Session events owned by [`dsh-tool-workflow`](../../workflow/tool-workflow/README.md), registers one `ConversationNodeDefinition`, and renders through the keyed `conversation.chat.node` slot without changing the existing workflow tool card.

## Durable state and replay

`tool-workflow/run-start` creates one Context keyed by `runId`; member starts, member endings, and the run ending update that Context in log order. A history tail containing only updates remains pending until an older page supplies the unique start, after which prepend, complete replay, and live append produce the same state. A closed Turn or Step with missing terminal events presents the affected run or members as interrupted without changing the tool result.

Phase groups come only from members that actually started. Exact phase strings share a group, an omitted phase is distinct from the empty string, and settlement changes status without removing or reordering members.

## Presentation and navigation

The run and each phase are controlled disclosures in every status. A mount opens running, failed, cancelled, and interrupted levels and closes fully completed levels; users can then toggle either level with the full row, Enter, or Space. Ordinary running updates preserve the current choice, the first abnormal edge opens once, normal completion closes once, and a completed phase plus the outer run open again when a new running member starts under the same phase key. If an entire new clean cycle arrives in one render while the run remains active, the phase finishes folded but the outer run opens once to expose its updated summary. Completion updates the visible status immediately but delays its automatic close while focus remains inside the content. `WorkflowRunPanel` owns the phase choices, so closing and reopening the outer run does not reset them; a renderer remount reconstructs every initial choice from durable facts. The run uses a 32-pixel `--dsw-alias-bg-module-platform` row with persistent right/down chevrons and an inline state dot plus status text, without a badge. Phases use 32-pixel disclosure rows with title and member count in the flexible main area and a fixed precise aggregate-status tail, without another dot. Members use a 16-pixel dot slot, a truncating name area, and a fixed 64-pixel status column.

A member opens its child Session whenever the child id is in the ordinary Session list with `origin: 'subagent'` and `parentId` equal to the current Session. Settlement does not revoke this: completed and interrupted members stay openable while their child row exists, because `sessions.open(id)` works on a finished child. Underlined member text is the only visible navigation affordance; keyboard focus draws a two-pixel business-primary ring around the name area, while the status copy remains the lifecycle word. The component calls only the injected ordinary `sessions.open(id)` action; rows whose child Session is absent from the ordinary list — remote, addressed-only, or wrong-parent — remain non-interactive.

## Composition

The package registers its Definition, locale dictionary, and `workflow-run` renderer as Cordis effects. Removing the client entry retracts all three contributions. The shipped Web bundle includes the plugin after `ui-conversation` and `ui-tool`.

## Model Experience

None, as this package renders durable Session facts for humans and adds no prompt, tool schema, request content, or model-visible result.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Only top-level calls through `dsh-tool-workflow` produce these records; nested Code Mode calls and direct `WorkflowEngine` consumers do not.
- Navigation follows the ordinary Session list: a member stays openable after settlement while its child row is listed, but a member whose child Session the list does not contain (for example a remote row) never exposes an opener from this node.
- The node shows run, phase, member identity, and status only; scripts, outputs, errors, logs, usage, static topology, and controls remain outside this surface.

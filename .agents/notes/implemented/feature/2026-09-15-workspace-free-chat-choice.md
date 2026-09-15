# Agent Note: Workspace-Free Chat Choice

Status: implemented

English | [中文](2026-09-15-workspace-free-chat-choice.zh.md)

## Problem

The New Session Workspace picker required a directory choice whenever a directory picker was available and offered no explicit route for a chat that should not use a Workspace. An empty Workspace list could open the directory flow immediately, which removed the user's ability to choose a workspace-free Session. The same picker is reused by the sidebar's add-only control, where a workspace-free action does not belong.

## Decision

The conversation picker receives `allowNoWorkspace` from `ConversationRoot`. The flag is true for the no-Session and blank New Session hero routes, and false for an active Session. When enabled, the picker renders the localized `workspace.menu.noWorkspace` action and routes it to `UiWorkspaceService.createLooseSession` through `WorkspacePickerInjected`. The service creates and opens a separate Session with `sessions.create({})`; it never retargets or detaches the Session currently displayed. Repeated requests share the pending creation, and only the latest navigation intent may open its result. The conversation owner clears its pending Workspace label before this action.

Each Workspace selection carries a cancellation signal. A later picker choice, a session change or component disposal cancels the previous selection; choosing no Workspace cancels it before requesting the loose Session. A late connection result cannot transfer the previous draft or attachments or open the stale target. The host may finish creating the unused blank Session, which remains intact.

The sidebar continues to use `WorkspacePickFlow` with `addOnly`, so it exposes only the composed directory flow. A no-workspace row makes the conversation menu non-empty even when the Workspace list is empty or no directory flow is occupied; the picker therefore waits for an explicit choice instead of auto-opening the directory flow. Existing directory adoption, busy, loading, error, retry, and cancellation behavior remains unchanged.

Workspace-free Sessions retain the existing stable internal `UNGROUPED_KEY` and render under the localized **Chats** label (`聊天` in Chinese). Workspace deletion copy uses the same label. The persisted key does not change.

## Alternatives considered

Reassigning an existing Session would change its workspace ownership. The picker instead creates a separate Session through the same operation used by the Chats group. The add-only sidebar control keeps directory creation as its single purpose.

## Consequences

New-chat users can choose a Workspace, add one through the existing directory flow, or create a workspace-free Session without changing an existing Session. Workspace-free conversations remain grouped and ordered through the current browser-local account and appear as **Chats** in the sidebar.

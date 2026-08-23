# Agent Note: Sidebar workspace section slot

Status: implemented

English | [中文](2026-08-23-sidebar-workspace-section-slot.zh.md)

## Problem

The sidebar gave ui-workspace exclusive ownership of its browsing region. A remote-SSH plugin needs a workspace-adjacent navigation section, but changing the shell for each domain couples optional integrations to core UI internals.

## Decision

ui-sidebar declares root-scoped list slot sidebar.workspace.section and renders it before the single sidebar.workspaces browser seat. Each entry receives only SidebarSectionOwnerProps: the current wide/rail state and an expansion request. External packages wait for the declaration with slots.inject() and register their own entry, so the contribution follows the sidebar declaration and plugin fiber lifetimes.

## Alternatives considered

**Replace sidebar.workspaces.** Rejected because the workspace browser owns search, session rows, and dialogs; a remote integration must not take over that product domain.

**Add a remote-SSH-specific sidebar API.** Rejected because sidebar placement is generic and several optional workspace-adjacent domains can use the ordered list without importing a remote service.

## Consequences

The shell owns one small ordered insertion point and no remote state. Section occupants must provide their own compact rail presentation and business data. sidebar.workspaces remains the single browser seat.

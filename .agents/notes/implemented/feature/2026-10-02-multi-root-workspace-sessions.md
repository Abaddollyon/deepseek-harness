# Agent Note: Sessions record additional workspace roots at creation

Status: implemented

English | [中文](2026-10-02-multi-root-workspace-sessions.zh.md)

## Problem

A task often spans a project directory and sibling directories such as a shared library or documentation. A Session's sandbox grants writes only under its `cwd`, so work in another directory needs `danger-full-access` or a second Session. Reading a Workspace's current directory list at each call would let one Workspace edit widen or narrow Sessions that already ran.

## Decision

A [Workspace](../../../../packages/workspace/workspace/README.md) keeps optional `additionalPaths`, replaced through the Remote `workspace.updatePaths` command or set by `workspace.create`. `session.create` in a Workspace copies the current list into the new Session as the ignorable `workspace/roots` event at seq 0. `Session.additionalPaths` reads that event, `append()` refuses its type, forks inherit it through their seed, and in-process subagent, workflow, and Team children receive it through `childSessionMeta`.

`sandbox-policy` resolves the list as `additionalRoots` and lists every root in the policy text. bwrap, Landlock, Seatbelt, the fs fence, and the SSH helper grant those roots like the `cwd` root. The windows-acl runner refuses workspace-write with additional roots. The `additionalPaths` Session projection shows a Session's list to clients.

## Alternatives considered

**A `SessionHeader` field.** The persistence-type rules classify any Session header change as a version bump. It would need a V5 writer and adjacent migration, plus changes to the V4 header validator, the JSONL header line, and the query cache.

**A required event.** Builds that do not know a required event refuse the whole log. Skipping this event only confines the Session to `cwd`, and the model-visible policy text is logged separately as runtime context, so the event does not shape reconstruction of recorded history.

**Read the Workspace list at each call.** A Workspace edit would change running and archived Sessions, and a Session that leaves its Workspace would lose its roots.

**Grant every root through the Windows ACL runner.** That needs a root-set write SID and new runner arguments that this deployment cannot exercise; refusing keeps Windows fail-closed.

## Consequences

A Session's writable roots are fixed at creation, and a Workspace edit applies to later Sessions only. Creation fails when a listed directory no longer exists. Builds without this change open such Sessions confined to `cwd`. A remote preset enforces the roots on its SSH host, which must hold every root. Focused tests cover the seq-0 event with restore and inheritance, the fs fence, policy resolution, Workspace validation, and the client folder dialog.

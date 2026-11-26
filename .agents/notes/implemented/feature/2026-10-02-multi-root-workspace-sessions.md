# Agent Note: Sessions record additional workspace roots at creation

Status: implemented

English | [中文](2026-10-02-multi-root-workspace-sessions.zh.md)

## Problem

A task often spans a project directory and sibling directories such as a shared library or documentation. A Session's sandbox grants writes only under its `cwd`, so work in another directory needs `danger-full-access` or a second Session. Reading a Workspace's current directory list at each call would let one Workspace edit widen or narrow Sessions that already ran.

## Decision

A [Workspace](../../../../packages/workspace/workspace/README.md) keeps optional `additionalPaths`, replaced through the Remote `workspace.updatePaths` command or set by `workspace.create`. `session.create` in a Workspace copies the current list into the new Session as the ignorable `workspace/roots` event at seq 0. `Session.additionalPaths` reads that event, `append()` refuses its type, forks inherit it through their seed, and in-process subagent, workflow, and Team children receive it through `childSessionMeta`.

`sandbox-policy` enforces the list through its per-Session writable-directory registrations ([upstream decision](../architecture/2026-10-26-session-writable-directory-effects.md)). One `agent/created` listener registers each `Session.additionalPaths` entry with the Agent's context as owner, for every start source (startup, resume, clear, compact), so the grants end with the Agent and a detached copy of the log receives none. Before registering, it checks each root with `lstat` through the working-directory service's filesystem for the Agent (the `working-directory/fs` waterfall); a root that is missing, not a directory, or a symlink is skipped with a warning. Resolved policies list configured extra directories first, then the recorded roots, and the policy text names them under `workspace-write` only. Every enforcing backend that honors `additionalWritableRoots` (bwrap, Landlock, Seatbelt, the fs fence, the SSH helper) grants them; Windows file tools honor them and Windows subprocesses ignore them, as for every extra grant ([Windows scope](../architecture/2026-10-29-windows-file-tool-directory-grants.md)). The `additionalPaths` Session projection shows a Session's list to clients.

## Alternatives considered

**A `SessionHeader` field.** The persistence-type rules classify any Session header change as a version bump. It would need a V5 writer and adjacent migration, plus changes to the V4 header validator, the JSONL header line, and the query cache.

**A required event.** Builds that do not know a required event refuse the whole log. Skipping this event only confines the Session to `cwd`, and the model-visible policy text is logged separately as runtime context, so the event does not shape reconstruction of recorded history.

**Read the Workspace list at each call.** A Workspace edit would change running and archived Sessions, and a Session that leaves its Workspace would lose its roots.

**Resolve the roots inside `sandbox-policy.resolve()`.** Upstream's policy reads grants only from configuration and live registrations, and declines to restore authority from Session history. Registering per Agent start keeps one grant path for every backend. The cost is that this fork re-registers from the stored event on resume, which upstream's design declines on purpose; the roots are the user's choice at creation, not a plugin's.

**Register a root that no longer exists.** Enforcement rejects a missing or symlinked extra root on every call with `SandboxInvalidRootError`, so one deleted sibling directory would stop all writes in the Session.

## Consequences

A Session's writable roots are fixed at creation, and a Workspace edit applies to later Sessions only. Creation fails when a listed directory no longer exists; a root deleted after creation is skipped on later Agent starts. Seed validation and `validateSessionLog` reject a `workspace/roots` event outside the ignorable seq-0 position, and both single and batch `append()` refuse it. `workspace/roots` and upstream's `workspace-root/change` (a Host move of the working directory) are different events. Builds without this change open such Sessions confined to `cwd`. A remote preset enforces the roots on its SSH host, which must hold every root. Focused tests cover the seq-0 event with restore, inheritance, and batch refusal, the fs fence, registration per Agent start with skipped stale roots, Workspace validation, and the client folder dialog.

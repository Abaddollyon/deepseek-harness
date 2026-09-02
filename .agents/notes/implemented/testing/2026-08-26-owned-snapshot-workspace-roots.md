# Agent Note: Owned snapshot workspace roots

Status: implemented

English | [中文](2026-08-26-owned-snapshot-workspace-roots.zh.md)

## Problem

Snapshot, Loader, and SDK subprocess harnesses generate a fresh cwd per run, and the web scaffold generates one per in-process boot. Product instruction and skill discovery walks upward from a session cwd to the nearest `.git` marker, so a generated cwd inherits whatever marked ancestor the host layout happens to provide: a primary checkout or sibling worktree above it can contribute `AGENTS.md` instructions and project skills to model-visible state. Recorded-session replay then depends on the developer's checkout layout, and the same scenario can compose different requests on different machines. DSH homes, profile patches, session persistence, and spill roots were already pinned under harness-owned paths; project-root discovery was the remaining unpinned input.

## Decision

Snapshot and Loader subprocess harnesses anchor each generated cwd as its own project root with an empty `.git` marker directory before boot; the web scaffold and the SDK snapshot lane apply the same marker to their generated workspaces. The marker is created when absent and kept when already a real directory, while a symlinked or file marker fails loud instead of aliasing foreign project state. This stops project instruction and skill discovery at the owning cwd instead of allowing a marked primary checkout or sibling worktree above it to contribute model-visible files. DSH homes, profile patches, session persistence, and spill roots remain under harness-owned paths, and captured workspace state excludes the harness-owned marker so committed expected trees need no Git-untrackable entry.

## Supersession check

The active workspace-context note (2026-06-24) remains authoritative for product root discovery and marker semantics; this note applies that mechanism to test-owned roots. The historical 2026-08-25 isolation change was inspected for intent only and is not treated as the implementation source because snapshot surfaces were renamed and restructured. No active note is fully superseded.

## Alternatives considered

**Leave generated roots unmarked.** Rejected because replay hermeticity then depends on the host's temp layout and on whether a developer runs the suite from inside a marked checkout; the failure is silent divergence of model-visible input, not a loud error.

**Detect a marked ancestor and fail the run.** Rejected because it punishes valid host layouts instead of making them irrelevant; the harness owns the cwd and can anchor discovery deterministically.

**Silently replace a conflicting marker.** Rejected because a symlinked or file `.git` in a freshly prepared cwd means workspace setup planted state the harness cannot account for; replacing it would hide that bug. Misconfiguration fails loud.

**Keep the marker out of the agent's directory listings.** Rejected because the marker genuinely exists in the cwd; hiding it from the agent while keeping it for discovery would make recorded model-visible output untruthful. Captured workspace state excludes it instead, alongside the other harness-owned root entries.

## Consequences

Replay composition no longer depends on the host checkout layout: every generated root discovers exactly its own seeded instructions and skills. The agent's own directory listings show the `.git` marker, so expected outputs that pin a root listing name it; captured initial and final workspace state excludes it, so `workspace.expected` comparisons need no Git-untrackable entry. A scenario whose workspace setup plants a conflicting marker entry fails before boot with the conflict named. The SDK lane gained the same anchoring and exclusion as the ACP, headless, Loader, and web scaffold lanes.

## Testing

The Loader smoke test executes two real temporary roots, asserts each subprocess cwd and marker, and asserts the roots differ; focused unit tests cover marker creation, tolerance of an existing real marker directory, and rejection of symlinked and file markers. Snapshot harness tests pin the marker's presence in the agent's own directory listing and its absence from captured workspace state. Focused snapshot and Loader tests cover execution paths rather than plan text.

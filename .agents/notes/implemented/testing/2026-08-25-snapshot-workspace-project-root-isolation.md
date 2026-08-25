# Agent Note: Snapshot harnesses anchor workspace project-root discovery

Status: implemented

English | [中文](2026-08-25-snapshot-workspace-project-root-isolation.zh.md)

## Problem

Keyless snapshot replays boot the real agent composition in a generated temp cwd, and both workspace-instruction discovery (AGENTS.md/CLAUDE.md) and project skill discovery walk UP from the session cwd to the first directory holding a project-root marker (`.git` by default). Every snapshot harness pinned `DSH_HOME` and `DSH_AGENTS_HOME` inside the generated cwd but left that walk unbounded, so a developer whose home directory is itself a git checkout — or whose TMPDIR lives inside one — replayed with the ambient ancestor as the project root: the host's AGENTS.md entered the log as a baseline `agent-instructions` user message and the host's `.agents/skills` as a `skill-catalog` message. The transcript stayed content-identical to the fixture except for `sourceEventSeqs` shifted by the extra events, so a documented command (`pnpm run test:snapshot`) failed on a clean checkout for purely environmental reasons while CI, with no marked ancestor above its checkout, passed.

The acp-agent `session-sandbox-root` scenario made the leak unavoidable rather than rare: it deliberately generates its cwd under the user home (`workspaceParent: homedir()`) because the temp-root grant itself is under test, so every home-as-repo developer reproduced it.

## Decision

`isolateWorkspaceProjectRoot(cwd)` in `@deepseek-ai/dsh-loader-smoke` seeds an empty `.git` marker directory into a harness-owned isolated cwd before the process boots, terminating the upward discovery walk at the cwd itself. The cwd becomes its own project root and discovery sees exactly the files the scenario seeded: the real seam stays enabled against the owned workspace, mirroring how the web replay scaffold already pins every host-level skill root inside its temp world (scaffold-hermetic.e2e.ts).

Every harness that creates an isolated example cwd calls it: `runLoaderSmoke` (the headless and CLI snapshot suites), `runScenario` (the ACP snapshot suite, after workspace seeding), and the in-process web replay scaffold through the `dsh-acp-snapshot` re-export. The marker is an empty directory, matching a real checkout's form; dot-prefixed entries stay invisible to `ls` without `-a` and to ripgrep-backed glob defaults, so no committed fixture churns. Record mode seeds the marker too, keeping record and replay symmetric on a recorder's machine.

## Alternatives considered

- **Re-record the fixture or stop comparing `sourceEventSeqs`** — hides the leak and weakens the comparison that catches genuine event-count regressions; the fixture was correct and the harness leaked.
- **Disable the agent-instructions row in replay compositions** — the web scaffold does exactly this, but the ACP suite ships scenarios (agent-instructions, code-mode-workspace-context) whose subject IS instruction loading, so a blanket disable would delete that coverage.
- **A harness-facing env or config override for the discovery walk** — new product surface for a harness concern; compositions that override `projectRootMarkers` already own their discovery semantics, and an env var would bypass the composition layer.
- **Per-scenario replay-overlay patches** — leaves future scenarios and the other harnesses unprotected; hermeticity belongs to the cwd owner, not to each scenario.

## Consequences

- The fake-agent harness specs echo the workspace through `readdir`, so their expectations now name the `.git` entry explicitly, pinning the marker as harness behavior.
- A scenario can no longer observe a real parent project root above its generated cwd; none did — scenario workspaces are self-contained, and `workspaceParent` scenarios keep their explicit parent for sandbox-grant coverage.
- In the web replay scaffold the agent-instructions row is disabled outright, so the marker guards only project skill roots against a marked TMPDIR; instruction isolation there remains the disable.

## Testing

- The acp-agent snapshot lane gains a regression test that replays `text-turn` with its cwd under an ancestor containing a `.git` marker, a sentinel AGENTS.md, and a sentinel `.agents/skills` bundle, and asserts neither sentinel enters the replayed log; without the marker seed it fails with exactly the two ambient events.
- A loader-smoke unit test asserts the marker directory exists in the isolated cwd before cleanup.
- Verification: `pnpm run test:snapshot`, `pnpm run typecheck`, `pnpm run build`.

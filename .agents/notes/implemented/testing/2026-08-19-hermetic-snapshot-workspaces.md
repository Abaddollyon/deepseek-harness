# Agent Note: Hermetic workspaces for keyless snapshot scenarios

Status: implemented

English | [中文](2026-08-19-hermetic-snapshot-workspaces.zh.md)

## Problem

A keyless snapshot scenario boots a real app subprocess in a generated working directory and diffs its persisted session log against a committed golden. The generated directory isolated `DSH_HOME` and `DSH_AGENTS_HOME`, but two model-visible inputs were still discovered by walking *upward* from that directory: workspace instructions (`dsh-agent-instructions` climbs to the first `.git` and reads every `AGENTS.md` / `CLAUDE.md` from there down) and skill roots (`dsh-skill-filesystem` climbs the same way, then scans `<projectRoot>/.dsh/skills` and `<projectRoot>/.agents/skills`). The subprocess also inherited the whole parent environment, including any `DSH_*` deployment variable exported in the developer's shell.

Under the platform temp root the upward walk usually finds nothing, so the leak stayed invisible. The `session-sandbox-root` scenario deliberately places its workspace under `os.homedir()` — its subject is that the sandbox root comes from `SessionHeader.cwd` rather than the process-level temp fallback — and a developer home that is itself a Git repository turned the whole home directory into the project root. That run recorded two extra `user/message` events (the home `AGENTS.md` and a skill catalog built from `~/.dsh/skills`), shifting every later `seq` and failing the whole log comparison. Both available responses were wrong: recording would commit one machine's skill list into the repository, and not recording would leave the suite red on that machine while staying green elsewhere.

## Decision

The isolated workspace is the unit of hermeticity, and [`dsh-loader-smoke`](../../../../packages/test-support/loader-smoke/README.md) owns its contract for both subprocess harnesses.

`anchorWorkspaceProjectRoot` creates the `.git` project-root marker inside the generated cwd before any fixture is seeded. Instruction discovery and skill discovery both terminate there, so the workspace parent contributes nothing and instruction display paths stay workspace-relative. `.git` is the marker because it is the `projectRootMarkers` default and the only name `dsh-skill-filesystem` recognizes; a marker outside the cwd would move the project root above it and put a generated directory name into model-visible display paths.

`isolatedSubprocessEnv` composes the child environment as the inherited environment minus every `DSH_*` entry, then the launch's own entries. Host variables (`PATH`, `HOME`, `NODE_OPTIONS`) still pass through; deployment values are declared by the test. `runLoaderSmoke` and `launchAcpTestAgent` apply both, so the ACP, headless, and `apps/cli` snapshot lanes share one guarantee.

A scenario that wants instructions or skills declares them as scenario data: `workspace/AGENTS.md` for instructions (the `agent-instructions` and `code-mode-workspace-context` scenarios), `workspace/.dsh/skills/<name>/SKILL.md` for skills (the `skill-load` scenario), or a repository-owned skill directory named by the composition (the `dsh-badge` CLI scenario). No scenario depended on ambient host content; `session-sandbox-root` absorbed it accidentally, and every scenario that asserts skills or instructions already declared its own source.

## Testing

`runScenario`'s workspace-listing fixtures now show the marker as the first entry, which is what proves the anchor exists at all. `loader-smoke` covers the anchor's idempotence, the environment composition, and an end-to-end run whose subprocess sees an empty workspace and no exported `DSH_*` value; `acp-snapshot` covers an ambient `DSH_PERMISSION_MODE` failing to reach the child. The regression itself is pinned by `session-sandbox-root`: before the anchor it failed on this machine with two extra `user/message` events, and after it the committed golden matches unchanged.

## Related

The [ACP snapshot Agent Note](2026-06-19-acp-snapshot-tests.md) owns the snapshot tier's fixture roles and record/replay/refresh semantics; the [workspace-context Agent Note](../feature/2026-06-24-workspace-context.md) owns instruction discovery, whose upward walk this workspace anchor bounds.

## Alternatives considered

**Normalize the extra events away.** A normalizer that drops instruction or skill reminders would hide a real regression in what the model receives, and the model-visible ⟺ logged invariant makes those events load-bearing. Repository policy is to fix fixtures, not normalizers.

**Re-record the golden on the recording machine.** This makes the committed log a snapshot of one developer's installed skills and home instructions; CI, a fresh clone, and every colleague would then disagree with it.

**Move the scenario's workspace back under the temp root.** The scenario exists to prove that a workspace outside the always-writable temp roots is still writable through `SessionHeader.cwd`; moving it deletes the coverage. It would also only hide the same class of leak for every other scenario.

**Give the scenario an isolated parent directory whose marker sits one level up.** Discovery would stop inside harness-owned territory, but the project root would no longer equal the session cwd, so instruction display paths would carry the generated workspace's directory name — a random value in model-visible text.

**Keep an allowlist of forwarded `DSH_*` variables.** The lane selectors (`DSH_SNAPSHOT`, `DSH_EXAMPLE_MODE`) are the only plausible entries, and both are resolved in the parent test process or declared per scenario. An allowlist would preserve exactly the ambiguity the change removes.

## Consequences

Every isolated subprocess workspace now contains a `.git` directory. It is hidden from the search tools' default listings and no scenario enumerates the workspace root, so no committed golden changed; the harness's own `readdirSync` echo fixtures did, and that visibility is the anchor's proof. Dropping inherited `DSH_*` means a test that relied on ambient forwarding must declare the variable, and a scenario without `DSH_SNAPSHOT` now always boots the non-snapshot branch of its config instead of following the developer's shell.

# Agent Note: Preset-owned execution worlds

Status: implemented

English | [中文](2026-10-02-preset-owned-execution-worlds.zh.md)

## Problem

The [SSH execution providers](2026-09-11-posix-ssh-runtime.md) give one composition a remote filesystem and process world, but Web composes every model-facing tool inside Agent presets. An SSH world mounted inside a preset's `isolate` group was invisible to Host consumers that act for a Session: Session creation created the cwd on the Host, the Files sidebar listed Host paths, the Terminal sidebar started a Host shell, and every child of a Session joined its parent's preset, so one parent could not start children on different hosts.

## Decision

An Agent preset that isolates `fs`, `subprocess`, `sandbox` and the tools using them is an execution world. Host consumers address that world through the preset registry instead of their own injections:

- `agentPresets.serviceForPreset(id, name)` reads a service the preset's current revision publishes inside an `isolate` realm, before any Agent joins it; `serviceFor(agent, name)` remains the live-Agent form.
- Session creation checks the cwd through the preset's `fs` when it mounts one. The directory must exist in that world and nothing is created on the Host; other presets keep the Host `mkdir`.
- `workspace-files` reads through the `fs` of the preset named by the Session projection, so a blank-Session preset switch applies. `terminal-controller` spawns through the `subprocess` the Agent's preset isolates.
- `agentPresets.ownsWorld(id)` reads world ownership from the declaration (an isolated `fs` or `subprocess`). When such a preset's provider is missing because its row failed or its host is offline, Session creation, Files, Terminal and Workspace path checks refuse instead of using the Host's, and a blank-Session switch checks the cwd and additional roots in the world it enters, the Host included.
- `tool-fs-search` takes an `rgPath` because the packaged ripgrep binary is a Host path.
- A Workspace record may name an `agentPreset`; its paths are canonicalized through that preset's `fs` and are unique per (preset, path). `workspace-controller` installs these path worlds on the registry, and Sessions created in such a Workspace start under its preset.
- A child may run under another preset and cwd through `ChildExecutionTarget`, supplied by an in-process provider (`startInProcessRun` options or `ContinuableCreateSpec.target`). The child header records both; `applyChildComposition` mounts the header preset when it differs from the parent's, so cold resume rejoins the same world. A targeted child starts without a fork seed, whose `workspace/roots` would carry Host roots into the other world. Workflow `agent()` selects such a provider per child with `subagentProvider`.

A deployment that wants a workflow script itself to run remotely mounts `ptc-runtime-node` (with an installed bootstrap), `workflow-ptc` and `tool-workflow` inside the same isolate group; a Host PTC runtime cannot start a process in a cwd that exists only remotely.

## Alternatives considered

**Run a complete Harness on each remote host and proxy its Web client.** It keeps remote work alive while the local Harness is down, but it needs a remote install, provider credentials on every host, tunnels and a second client runtime. Local presets keep model access, approvals and Session storage in one Host.

**Keep the Host `mkdir` and create matching local directories.** It leaves stray Host directories and fails for paths the Host user cannot create, such as `/root/x`.

**Select the child preset from the parent's tool call.** A model-visible preset argument would expose deployment topology in every delegation schema. Providers carry the target, so the existing `subagent` and workflow schemas stay unchanged and a deployment names hosts by provider.

## Consequences

Consumers that act for a Session must ask the registry for preset-owned services; a consumer that injects `fs` or `subprocess` directly still sees the Host. `workspace-files` observes the Session projection on each scope lookup. A Workspace or Session on a preset whose world is unavailable fails its operations until the preset recovers. Upstream `SshConnection` does not reconnect: after a transport loss every operation of that preset revision fails until the deployment recreates the connection.

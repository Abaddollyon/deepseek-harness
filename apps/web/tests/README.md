# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with a real
Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and
the deliberate composition divergences from `dsh web` — are documented in
[`scaffold.ts`](scaffold.ts) and the
[browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

Fresh-workspace scenarios use the localized helpers in [`support.ts`](support.ts) to enter New Session from the Environments overview before opening the Hero workspace picker. A mounted composer beneath the overview is not an interactive conversation.

Reload restores the selected Session independently of the shell location. Root-Session transcript scenarios use `openSelectedSession` to enter the restored selection through its sidebar row. Child Sessions have no sidebar row; enter the parent and open the child through its subagent catalog after asserting the restored selection.

Skill fixtures in a nested workspace create that directory and call `isolateWorkspaceProjectRoot` before seeding `.agents/skills`. Discovery uses the nearest `.git` project root; the enclosing scaffold's marker does not make the nested workspace a project root. Keep the workspace and marker beneath the scaffold's private temporary directory so scaffold cleanup removes both.

[`workflow-run.e2e.ts`](workflow-run.e2e.ts) combines recorded model responses for the workflow call, child, and final answer with one fixture-authored waiting response in a private temporary `replayOverride`. This exercises the shipped supervisor's initial parent settlement and completion-triggered turn without changing canonical Session recordings. It is fixture-backed acceptance, not evidence of a new recording or a live model round.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate,
because they read Host services directly: `ctx.connection`, the Host
`SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does
not make a file part of the Client program — the two faces merge cordis
`Context` under the same keys with different services, so one program cannot see
both. Moving these files into the Client aggregate makes every Host-service
access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript
project, and every project it references, into the **Host build graph**. That has
bitten this lane once already: four Client consumer packages reference
`api/remotes`' Client face, which cannot compile until Host tsdown has generated
`@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an
artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here
instead, next to the commented-out import that names the source module. A drift
then surfaces as a missed selector or a stale mirrored value — a loud failure,
never a silent pass. `scaffold.ts` follows this rule for the welcome-notice
namespace, acknowledgement field, version, and asserted Chinese copy.

One kind of Client import stands. `assembled-boot.ts` drives the shell itself, so
it imports `AppWebEntry` from `@deepseek-ai/dsh-client-web` and the boot-manifest
type from `@deepseek-ai/dsh-client-modules/client`: booting the real shell is what
that harness is for, and both packages are already in the Host graph. The chat
scenarios mirror `conversationContextKey` in `support.ts` instead of importing
its Client owner.

Nothing mechanically enforces this rule; keep it in review.

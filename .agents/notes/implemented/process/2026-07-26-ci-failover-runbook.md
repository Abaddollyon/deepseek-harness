# Agent Note: CI failover runbook — hosted pools → in-house pool

Status: implemented

English | [中文](2026-07-26-ci-failover-runbook.zh.md)

## Problem

Hosted-pool outages can leave required checks queued indefinitely, preventing responders from merging a workflow fix through the affected checks. The original private-repository failover decision used two independent writer-manageable switches so an outage on one platform did not redirect the other. Its primary motivation was recovery without a merge, not permanent dependence on the private pools.

## Decision

The original decision routed eligible main-CI Linux jobs, the Node compatibility matrix, and the verdict through `DSH_CI_FAILOVER_LINUX`, and native Windows jobs through `DSH_CI_FAILOVER_WINDOWS`. The [public hosted CI decision](2026-09-10-public-hosted-ci.md) supersedes that pull-request routing: every job in [CI](../../../../.github/workflows/ci.yml), including `all-checks-passed`, stays on standard hosted runners regardless of either variable. Its actual-runner cache and browser provisioning and conservative concurrency replace the private-PR setup. The alternatives below retain the original recovery rationale; they do not authorize restoring private PR routing.

The `serial / linux (self-hosted standby)` and `serial / windows (self-hosted standby)` jobs in [master CI](../../../../.github/workflows/ci-master.yml) retain complete unsharded aggregates. Each requires a master push, a private repository, and `DSH_CI_PRIVATE_RUNNER_REPOSITORY` equal to the full `github.repository` name. Without that exact opt-in, they skip before runner allocation. This scheduling predicate is not runner authorization; administrators must exclude public repositories from private runner-group access.

`ci-master.yml` exempts exactly one event from `cancel-in-progress` (`${{ github.event_name != 'push' }}`), so one master push does not cancel the drill still running from the previous one. Each drill runs its complete unsharded aggregate with one gate worker, which takes longer than the interval between master merges; under unconditional cancellation a drill is superseded before reaching a verdict and the lane yields no readiness evidence for a responder to check.

The exemption is narrower than "a drill always finishes", in two ways. GitHub keeps a single pending entry per group, so a newer pending run displaces an older one and intermediate push runs still end as `cancelled` during busy periods. And the expression is evaluated against the *newly triggered* run, so a run whose own event is not `push` — a benchmark dispatched on master within `ci-master.yml`, sharing its group `CI master-<ref>` — evaluates to `true` and does cancel a drill that is mid-flight. That is a rare manual action and the next master push restores the evidence, so it does not warrant further mechanism. What the carve-out buys is that the lane periodically reaches a verdict at all, which is what makes it usable as evidence.

The decision belongs at workflow level because cancellation applies to the whole superseded run: a job-level `concurrency` group does not exempt its job. The negated form is load-bearing rather than cosmetic: naming `pull_request` alone would also stop cancelling `workflow_dispatch`, and each runner benchmark fans out to twelve larger runners for up to fifteen minutes inside this same group on master, so a re-dispatch would queue ahead of a drill instead of replacing a stale measurement. What bounds the cost is that a master push in `ci-master.yml` carries the [post-merge runtime and Wine checks](2026-09-06-master-only-platform-ci.md) and these two drills; the pull-request jobs live in the separate `ci.yml` (which does not see `push`), and the benchmarks are `workflow_dispatch`-gated within `ci-master.yml`. `scripts/ci-workflow.spec.ts` pins that push-reachable set — classifying by exact condition, since a negated event test mentions the event it excludes — so a new push-reachable job cannot quietly start accumulating uncancelled runs.

### Release rehearsals retain the Linux switch

`DSH_CI_FAILOVER_LINUX=selfhosted` routes the credential-free dependency-layout job and both dsh/vendor pack jobs onto `vm-backup` for eligible same-repository PRs and master pushes. Their [release rehearsal decision](2026-09-06-release-rehearsal-selfhosted.md) owns event eligibility and hosted manual dispatch. Clearing the variable returns those workloads to their hosted targets on subsequent runs; publication stays hosted regardless. The variable does not route main-CI jobs or enable the master standbys. `DSH_CI_FAILOVER_WINDOWS` has no remaining workflow selector.

### What the in-house pool is

`vm-backup`: one shared VM with multiple always-on systemd-managed runner instances. Registrations share its CPU, memory, and disk; their count is not a count of independent machines. Its image must preinstall Playwright Chromium's Linux system packages; CI downloads the lockfile-selected browser but never runs `apt` on this persistent shared host. Check the latest `serial / linux (self-hosted standby)` run before switching: its aggregate includes browser replay, so a green standby verifies both ordinary capacity and this browser prerequisite.

#### Windows pool

`dsh-win-ci`: 32 always-on runner instances (scheduled tasks `GH-Runner-01`…`GH-Runner-32`) on the in-house Windows CI server (one 96-core / 580 GB machine). Labels: `[self-hosted, dsh-win-ci, windows]`. The image must preinstall Node 24, pnpm, Git (with Git Bash on `PATH`, i.e. `C:\Program Files\Git\bin` — the `bash` tool spawns `bash` by name), PowerShell 7, and enable Developer Mode for symlink support. The general-purpose Windows workspaces and pnpm store must both live on a ReFS volume (`F:`): those installs pass `--package-import-method=clone` on ReFS, which needs that volume layout and the `@reflink/reflink` native module that the system corepack pnpm carries (see [the Windows ReFS store note](../../archived/process/2026-08-30-windows-refs-store-block-clone-install.md)); a rebuilt runner without this layout fails the Windows build gates with TS6231. Check the latest `serial / windows (self-hosted standby)` run before switching: a green standby verifies the pool can execute `check:ci:windows-complete` end-to-end.

### Enable private standbys and release failover

Private standby opt-in and release rehearsal routing are independent settings. Neither restores pull-request CI during a hosted outage.

1. In the private repository's **Settings → Secrets and variables → Actions → Variables**, set `DSH_CI_PRIVATE_RUNNER_REPOSITORY` to its exact full repository name. A subsequent master push can execute both standbys; public repositories skip them even with a matching variable.
2. Check the complete standby result and current host pressure. For eligible release rehearsal jobs only, set `DSH_CI_FAILOVER_LINUX` to `selfhosted` when selecting the private Linux pool.
3. Retrigger affected release jobs so they resolve their pool again. Queued jobs do not retarget in place: cancel and re-run all jobs, or push a new commit. “Re-run failed jobs” only applies after failure, not while a job remains queued.

**Dependabot exception.** Release rehearsal selectors exclude `dependabot[bot]`; a maintainer rerun does not change the PR author. Main-CI PR jobs stay hosted for all authors.

**Who can flip the variables.** Repository writers can manage Actions variables. The original private, fork-disabled repository admitted all its workflows to the runner groups, so writers already had private-host access through branch workflows. That original membership-based trust assumption does not apply to public repositories. Variables route work; the runner service's access restrictions authorize it.

## Capacity during failover

Capacity includes opted-in master standbys and three release-rehearsal jobs for each eligible PR or master push while the Linux switch is set. Main-CI workers and the Node compatibility matrix consume hosted capacity, not this VM. The release workflows do not cancel running rehearsals when another run arrives, so overlapping refs can add sustained build, pack, and install load. Check current CPU, memory, disk, and queue pressure before extending self-hosted operation; extra registrations on this VM add scheduling slots, not machine resources. Do not infer spare capacity from the standby alone. When host resources permit extra registrations, use an org registration token (org Settings → Actions → Runners → New runner). Clone an existing runner directory **excluding its identity files** — `rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/` (the globs also catch `.runner_migrated`/`.credentials_migrated`, which GitHub writes on migrated runners and which equally trigger the already-configured refusal) — then run `config.sh` (copying `.runner`/`.credentials` verbatim makes it refuse with "already configured"), and **start the listener**: `sudo ./svc.sh install ubuntu && sudo ./svc.sh start`. Registration alone leaves the runner offline; a started service adds a scheduling slot, not CPU or memory.


### Switch back

Clear `DSH_CI_FAILOVER_LINUX` to return subsequent release rehearsals to hosted runners. Clear `DSH_CI_PRIVATE_RUNNER_REPOSITORY` to skip subsequent private standby jobs. Neither changes an already allocated job. Remove extra instances registered during an incident when they are no longer needed.

### Trust boundary

The original PR-ref failover executed each PR merge ref's own workflow definition and relied on private, fork-disabled repository membership, not its variable or head-repository predicates. Pinning the runner group to a master-ref workflow was incompatible with those PR-ref jobs: they remained queued in the July 27 incident until the group admitted all workflows of that private repository. That historical trade-off must not be copied to a public repository. The [hosted-only PR policy](2026-09-10-public-hosted-ci.md) gives up that main-CI failover route; private runner-group restrictions must remain enforced independently of contributor-controlled YAML.

## Alternatives considered

**Merge a workflow change to switch pools.** Rejected because the outage that motivates the switch is exactly the state in which no PR can merge: the required checks are the ones failing. A repository variable is writer-manageable state that takes effect on re-run without a merge.

**Keep the self-hosted pool always in the required path.** Rejected because it trades hosted-pool availability for the in-house VM's, moving a single point of failure rather than adding a fallback. The unset defaults retain hosted targets and the switches provide a reversible, operator-selected self-hosted path; splitting them by platform means an outage on one platform does not retarget the other.

## Consequences

The retained release switch provides operator-selected private Linux capacity without a merge, and opted-in standbys validate both private platforms. Main-CI pull requests depend on standard hosted availability and cannot use these variables to bypass a hosted outage. Operators maintain the private images, account for shared-host load, and restrict runner access independently of workflow predicates. Hosted cache warming remains separate from the persistent private stores.

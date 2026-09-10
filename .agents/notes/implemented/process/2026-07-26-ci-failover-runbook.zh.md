# Agent Note: CI 故障切换手册 — 托管池 → 自有池

Status: implemented

[English](2026-07-26-ci-failover-runbook.md) | 中文

## 问题

托管池故障可能使必需检查无限排队，导致响应者无法通过受影响的检查合并工作流修复。原始私有仓库故障切换决策使用两个独立、写者可管理的开关，避免一个平台的故障重定向另一个平台。其主要动机是无需合并即可恢复，而不是永久依赖私有池。

## 决策

原始决策通过 `DSH_CI_FAILOVER_LINUX` 路由符合条件的主 CI Linux 作业、Node 兼容性矩阵与判定作业，通过 `DSH_CI_FAILOVER_WINDOWS` 路由原生 Windows 作业。[公共托管 CI 决策](2026-09-10-public-hosted-ci.zh.md)取代该拉取请求路由：[CI](../../../../.github/workflows/ci.yml) 中的所有作业，包括 `all-checks-passed`，无论这两个变量的值如何都使用标准托管运行器。基于实际运行器的缓存与浏览器配置及保守并发取代私有 PR 设置。下方替代方案保留原始恢复理由，不授权恢复私有 PR 路由。

[Master CI](../../../../.github/workflows/ci-master.yml) 中的 `serial / linux (self-hosted standby)` 和 `serial / windows (self-hosted standby)` 保留完整、未分片的聚合检查。每个作业都要求 master 推送、私有仓库，以及 `DSH_CI_PRIVATE_RUNNER_REPOSITORY` 等于完整的 `github.repository` 名称。没有精确启用值时，作业在分配运行器前跳过。该调度条件不是运行器授权；管理员必须禁止公共仓库访问私有运行器组。

`ci-master.yml` 只豁免一个事件不做取消（`${{ github.event_name != 'push' }}`），因此一次 master 推送不会取消上一次推送留下的、仍在运行的演练。每次演练以单门禁工作进程执行完整的未分片聚合流程，耗时长于 master 合并的间隔；在无条件取消下，演练会在得出结论前被后续运行取代，该通道无法产出供响应者查看的就绪证据。

这项豁免比「演练总能跑完」要窄，有两点限制。其一，GitHub 每个组只保留一个待运行条目，更新的待运行条目会顶掉更早的，繁忙时段中间的推送运行仍会以 `cancelled` 结束。其二，该表达式是针对**新触发的运行**求值的，因此自身事件不是 `push` 的运行——例如在 `ci-master.yml` 内的 master 上派发的基准测试，与其演练共用 `CI master-<ref>` 组——求值为 `true`，会取消正在运行中的演练。这属于罕见的手动操作，且下一次 master 推送即可恢复证据，因此不值得为它再加机制。这项豁免换来的是该通道**周期性**地得出结论，而这正是它能作为证据的前提。

这个决定必须放在工作流级：取消作用于被取代的整个运行，作业级 `concurrency` 组并不能豁免其所属作业。采用否定式写法而非仅指名 `pull_request`，是有实质作用的：后者会连 `workflow_dispatch` 一起停止取消，而每次运行器基准测试会在 master 上的同一并发组内同时占用 12 台大规格运行器、最长 15 分钟，届时重复派发会排在演练之前，而不是替换掉已过时的测量。成本之所以可控，是因为 `ci-master.yml` 中一次 master 推送承载[合并后的运行时与 Wine 检查](2026-09-06-master-only-platform-ci.zh.md)和这两条演练；拉取请求作业位于独立的 `ci.yml`（不监听 `push`），而基准测试在 `ci-master.yml` 内受 `workflow_dispatch` 门控。`scripts/ci-workflow.spec.ts` 会锁定这个推送可达集合——按条件精确匹配，因为否定式事件判断会包含它所排除的事件名——使新的推送可达作业无法悄悄开始累积未取消的运行。

### 发布演练保留 Linux 开关

`DSH_CI_FAILOVER_LINUX=selfhosted` 将符合条件的同仓库 PR 和 master 推送中的无凭据依赖布局作业与 dsh/vendor 两个打包作业路由到 `vm-backup`。[发布演练决策](2026-09-06-release-rehearsal-selfhosted.zh.md)负责事件准入及保留托管的手动触发。清除变量会让这些负载的后续运行返回托管目标；发布操作始终托管。该变量不路由主 CI 作业，也不启用 master 待命。`DSH_CI_FAILOVER_WINDOWS` 没有剩余的工作流选择器。

### 自有池是什么

`vm-backup`：一台共享虚拟机，运行多个常驻 systemd 管理的运行器实例。注册实例共享 CPU、内存和磁盘；实例数量不代表独立机器数量。其镜像必须预装 Playwright Chromium 的 Linux 系统软件包；CI 会下载锁文件选定的浏览器，但绝不在这台持久化共享主机上运行 `apt`。切换前先看 `serial / linux (self-hosted standby)` 最近一次运行：其聚合流程包含浏览器回放，因此绿色热备同时验证常规容量和这项浏览器先决条件。

#### Windows 池

`dsh-win-ci`：公司内部 Windows CI 服务器（一台 96 核 / 580 GB 机器）上 32 个常驻运行器实例（计划任务 `GH-Runner-01`…`GH-Runner-32`）。标签：`[self-hosted, dsh-win-ci, windows]`。镜像必须预装 Node 24、pnpm、Git（Git Bash 在 `PATH` 上，即 `C:\Program Files\Git\bin`——`bash` 工具按名称 spawn `bash`）、PowerShell 7，并为符号链接支持启用开发人员模式。通用 Windows 通道的工作区与 pnpm store 必须都位于 ReFS 卷（`F:`）上：这些安装步骤在 ReFS 上传递 `--package-import-method=clone`，这需要该卷布局以及系统 corepack pnpm 携带的 `@reflink/reflink` 原生模块（见 [Windows ReFS store note](../../archived/process/2026-08-30-windows-refs-store-block-clone-install.md)）；没有此布局的重建运行器会在 Windows 构建门禁阶段以 TS6231 失败。切换前先看 `serial / windows (self-hosted standby)` 最近一次运行：绿色热备验证该池能端到端执行 `check:ci:windows-complete`。

### 启用私有待命和发布故障切换

私有待命启用与发布演练路由是独立设置。两者均不能在托管故障期间恢复拉取请求 CI。

1. 在私有仓库的 **Settings → Secrets and variables → Actions → Variables** 中，将 `DSH_CI_PRIVATE_RUNNER_REPOSITORY` 设置为准确的完整仓库名称。后续 master 推送可以执行两个待命作业；公共仓库即使变量匹配也会跳过。
2. 检查完整的待命结果和当前主机压力。仅针对符合条件的发布演练作业，选择私有 Linux 池时将 `DSH_CI_FAILOVER_LINUX` 设为 `selfhosted`。
3. 重新触发受影响的发布作业，使其再次解析运行器池。排队作业不会原地改向：取消并重新运行全部作业，或推送新提交。“Re-run failed jobs”仅适用于已经失败的作业，不适用于仍在排队的作业。

**Dependabot 例外。** 发布演练选择器排除 `dependabot[bot]`；维护者重跑不会改变 PR 作者。主 CI 拉取请求作业对所有作者均保持托管。

**谁能设置变量。** 仓库写者可以管理 Actions 变量。原始私有、禁 fork 仓库的运行器组接纳该仓库全部工作流，因此写者已经可以通过分支工作流访问私有主机。该基于成员资格的原始信任假设不适用于公共仓库。变量负责路由，运行器服务的访问限制负责授权。

## 切换期间的容量

Linux 开关启用期间，容量需覆盖显式启用的 master 待命，以及每个符合条件的 PR 或 master 推送的三个发布演练作业。主 CI 作业和 Node 兼容性矩阵消耗托管容量，而不是这台虚拟机。发布工作流不会因为新运行到来而取消正在执行的演练，因此不同引用的重叠运行会增加持续的构建、打包和安装负载。延长自托管运行前，检查当前 CPU、内存、磁盘和队列压力；同一虚拟机上新增注册只增加调度槽位，不增加机器资源。不能只依据热备负载推断空闲容量。主机资源允许增加注册实例时，使用组织级注册 token（组织 Settings → Actions → Runners → New runner）。复制现有 runner 目录时**必须排除身份文件**——`rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/`（通配同时排除 `.runner_migrated`/`.credentials_migrated`——GitHub 会在迁移过的运行器上写入这些文件，它们同样会触发 already-configured 拒绝）——再跑 `config.sh`（原样拷贝 `.runner`/`.credentials` 会使其以 "already configured" 拒绝），然后**启动监听器**：`sudo ./svc.sh install ubuntu && sudo ./svc.sh start`。仅注册不会上线；启动服务增加的是调度槽位，而非 CPU 或内存。


### 切回

清除 `DSH_CI_FAILOVER_LINUX`，使后续发布演练返回托管运行器。清除 `DSH_CI_PRIVATE_RUNNER_REPOSITORY`，使后续私有待命作业跳过。两者都不改变已经分配的作业。故障期间新增注册的实例不再需要时应移除。

### 信任边界

原始 PR 引用故障切换执行每个 PR 合并引用自带的工作流定义，依赖私有、禁 fork 仓库的成员资格，而不是变量或头部仓库条件。将运行器组绑定到 master 引用工作流与这些 PR 引用作业不兼容：在 7 月 27 日的事件中，它们持续排队，直到该私有仓库的所有工作流获准进入运行器组。该历史取舍不能复制到公共仓库。[仅托管 PR 策略](2026-09-10-public-hosted-ci.zh.md)放弃这一主 CI 故障切换路径；私有运行器组限制必须独立于贡献者控制的 YAML 执行。

## 曾考虑的替代方案

**通过合并一次工作流改动来切换池。** 否决，因为触发切换的故障状态恰恰是任何 PR 都无法合并的状态：必需检查正是失败的那些。仓库变量是写者可管理的状态，重跑即生效，无需合并。

**让自托管池长期处于必需路径中。** 否决，因为这是拿托管池的可用性去换自有虚拟机的可用性，只是搬移了单点故障而非增加回退。未设置变量时默认保留托管目标，开关提供由运维人员选择、可逆的自托管路径；按平台拆分意味着一个平台的故障不会重定向另一个平台。

## 后果

保留的发布开关无需合并即可选择私有 Linux 容量，显式启用的待命验证两个私有平台。主 CI 拉取请求依赖标准托管可用性，不能用这些变量绕过托管故障。操作员维护私有镜像、计入共享主机负载，并独立于工作流条件限制运行器访问。托管缓存预热与私有持久存储相互独立。

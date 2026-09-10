# Agent Note: 自托管 Linux 上隔离的 Node 兼容性作业

Status: implemented

[English](2026-09-06-node-compatibility-selfhosted.md) | 中文

## 问题

原始私有仓库优化将 Node 22.19、24.9 和 26 兼容性作业移至已经选定的私有 Linux 池，以减少托管分钟数。持久化共享机器上的版本安装器需要隔离，避免工具目录冲突，以及生成的缓存积累在运行器清理范围之外。

## 决策

原始决策为非 Dependabot、同仓库且非 fork 的拉取请求选择私有 Linux 容量，并隔离各个运行时安装。[公共托管 CI 决策](2026-09-10-public-hosted-ci.zh.md)取代该运行器选择：无论故障切换变量或 PR 来源如何，[CI](../../../../.github/workflows/ci.yml) 的三个矩阵条目均使用 `ubuntu-latest`。托管设置使用按版本配置的 `actions/setup-node`、pnpm 缓存和现有的运行器私有 pnpm 安装目录。PR 工作流不包含私有运行器预加载、缓存隔离和可执行文件路径检查。

保留的 [ESM 预加载模块](../../../../scripts/ci-compatible-toolcache.mjs)记录原始隔离机制，但没有活跃的 PR 工作流消费者。Actions 运行器在读取步骤配置后覆盖保留的环境变量，因此预加载模块在设置 action 进程内部指定临时工具缓存。原始设置将编译缓存与 node-gyp 头文件置于运行器清理范围内，保留共享的内容寻址 pnpm store，并检查安装后可执行文件的路径。这以重复下载 Node 为代价，换取并发运行器及版本之间的隔离，而不修改全局 Node 符号链接或系统软件包。任何复用均需要新的接线与隔离证据；历史检查不能授权私有 PR 执行。

[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)负责剩余的发布演练路由与私有待命启用。[串行参考决策](2026-07-21-serial-cross-platform-ci-reference.zh.md)记录完整 master 聚合检查。它们的剩余职责独立于仅托管的兼容性矩阵。下方替代方案保留原始优化理由，而非重新开放 PR 故障切换。

## 曾考虑的替代方案

**让所有兼容性作业保持托管。** 这避免额外的共享主机负载，但继续为不需要不同操作系统或架构的 Linux 运行时检查付费。

**使用共享 Node 安装或全局版本管理器链接。** 这些作业必须并发运行不同的 Node 版本。可变的共享链接会使选中的版本取决于另一作业的时序。

**在同一改动中迁移 Python SDK 作业。** 其 setup-python 安装和通过全局 pip 安装 uv 需要单独的隔离证据。这个短暂的托管作业不是 Node 优化的必需部分。

## 后果

兼容性检查消耗托管容量，而不是给共享私有虚拟机增加三个作业。每个条目保留门禁并发度一，包括需要构建的 Node 22 条目，并保留相同版本名称、兼容性和 loader 检查。托管 pnpm 缓存保持启用。原始 9 月 6 日清单中的 31 个 Linux 注册指运行器实例，而非独立机器；共享主机争用仅与剩余私有工作负载相关。兼容性矩阵不改变 master 调度。

## 验证

聚焦的[工作流回归测试](../../../../scripts/ci-compatible-selfhosted.spec.ts)锁定跨作者、仓库来源和故障切换值的托管路由、所有版本条目、托管缓存设置，以及私有运行器设置的缺失。它独立执行保留的预加载模块；更广泛的[工作流测试](../../../../scripts/ci-workflow.spec.ts)检查每个直接 PR 运行器标签与必需汇总。下方历史运行证明原始私有安装行为，而非当前 PR 路由或私有池容量保证。

实施基线上的[成功热备运行 33984559660](https://github.com/deepseek-harness/deepseek-harness/actions/runs/33984559660) 提供 Linux Node 24.19.0 和 Windows Node 24.20.0 基线证据。Linux 作业 101359402557 使用数据卷上运行器专属的临时目录和工具目录。[只读能力探测 34012679056](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012679056/job/101431064925) 报告 Linux x64、192 个在线逻辑 CPU、GCC/G++ 13.3、Make 4.3 和 Python 3.12.3。Python 3.10 缺失，进一步说明 SDK 需要单独配置。`282519d2` 上的 [PR 运行 34013779750](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34013779750) 验证了自托管 Linux 上的 Node 22.19.0、24.9.0 和 26.8.1，包括设置、可执行文件路径检查、兼容性测试和 post actions。可执行文件位于各运行器的 `_temp/node-compat-toolcache/node/<version>/x64/bin` 下；完成的作业分别耗时 228s、94s 和 101s。这些观测证明版本与路径兼容性，而非独占主机的容量保证。

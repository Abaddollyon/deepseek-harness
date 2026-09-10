# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试在进程内启动真实的 web 组合，并用真实 Chromium 通过真实 HTTP 驱动它。该 lane
的运行机制——模式、fixture、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在
[`scaffold.ts`](scaffold.ts) 和
[浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)中。

首次连接工作区的场景使用 [`support.ts`](support.ts) 中对应语言的辅助函数，从环境概览进入新会话，再打开 Hero 工作区选择器。概览下方已挂载的输入框不代表可交互的会话。

重新加载时，所选 Session 的恢复与 shell 当前页面相互独立。根 Session 的 transcript（文本记录）场景通过 `openSelectedSession` 点击侧边栏行，进入恢复后的所选会话。子 Session 没有侧边栏行；断言恢复后的选择后，进入父会话，再通过其 subagent 目录打开子会话。

嵌套工作区中的 skill（技能）fixture 先创建工作区目录并调用 `isolateWorkspaceProjectRoot`，再写入 `.agents/skills`。发现逻辑采用最近的 `.git` 项目根目录；外层 scaffold 的标记不会使嵌套工作区成为项目根目录。工作区与标记都应放在 scaffold 的私有临时目录内，以便 scaffold 清理时一并删除。

[`workflow-run.e2e.ts`](workflow-run.e2e.ts) 在私有临时 `replayOverride` 中，将录制的 workflow 工具调用、子会话响应和最终响应与一条由 fixture 编写的等待响应组合起来。这在不更改规范 Session 录制的前提下，验证已发布 supervisor 的父会话首次结算以及完成事件触发的下一轮。它是基于 fixture 的验收，不是新录制或真实模型轮次的证据。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取
Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动
浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 cordis
`Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处
Host 服务访问都无法编译。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程
拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的
Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译，
于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的
import 点明源模块。这样漂移会表现为选择器未命中或镜像值过期——是响亮的失败，绝不会是静默
通过。`scaffold.ts` 按此规则镜像欢迎声明的 namespace、确认字段、版本和被断言的中文文案。

有一类 Client import 是长期成立的。`assembled-boot.ts` 驱动 shell 本身，因此它从
`@deepseek-ai/dsh-client-web` import `AppWebEntry`、从
`@deepseek-ai/dsh-client-modules/client` import boot manifest 类型：启动真实 shell 正是该
harness 的用途，且这两个包本来就在 Host 图中。chat 场景则在 `support.ts` 中镜像
`conversationContextKey`，而不 import 其 Client owner。

没有任何机制强制这条规则；靠 review 守住它。

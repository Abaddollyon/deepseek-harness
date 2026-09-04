# Agent Note: Pwsh 初始化接受自有的空闲提示词

Status: implemented

[English](2026-09-05-pwsh-initialization-accepts-owned-idle-prompt.md) | 中文

## 问题

持久化 pwsh 工具会在 terminal 后端已经完成启动后，用自己的私有提示词替换后端提示词。工具的第二段初始化随后仍要求 `stdin_read`，但默认 Windows 后端无法观察到该状态。后端的确切就绪检查仍预期后端提示词，因此替换后的提示词以 `inferred_idle` 结算；工具会继续轮询直至耗尽整条命令的截止时间，并且始终不会派发首条命令。

工具已经通过 `promptCompleted` 识别自己的确切提示词尾部。任意 `inferred_idle` 输出仍不足以表示就绪，因为静默不能证明提示词覆盖已执行。

## 决策

第二段初始化接受 `stdin_read`，或接受带有确切工具自有提示词尾部的 `inferred_idle`。如果 inferred-idle viewport 没有该提示词，工具会在现有截止时间内继续轮询。session 退出与 terminal 超时仍属于初始化失败，取消或失败仍会关闭不可用的 shell。

terminal 后端仍会在发布已生成的 session 前执行自身的严格启动检查。本决策只适用于工具提交提示词覆盖之后；它不会削弱后端启动或命令完成标记。

## 备选方案

**接受每个 `inferred_idle` 初始化结果。** 否决：提示词覆盖执行前也可能出现输出静默，这会允许过早派发命令。

**继续要求 `stdin_read`。** 否决：原生 Windows 无法为工具自有提示词提供该观察，因此首条命令会耗尽整个截止时间。

**移除工具自有提示词或导入后端提示词。** 否决：命令回退与提示词剥离目前依赖私有提示词，而导入某个提供方的提示词会把工具与该提供方耦合。

**增加初始化截止时间。** 否决：这只会延长确定性的等待，而 Windows 后端无法产生所需证据。

## 验证

包级回归用例覆盖带有确切自有提示词的 inferred-idle viewport，拒绝只有旧后端提示词的 inferred idle，并把首条命令的派发推迟到后续轮询呈现自有提示词之后。既有退出、超时、取消、失败与 dispose 用例继续覆盖 shell 清理。

## 影响

原生 Windows 可以完成工具自有提示词转换，而不必等待命令截止时间。报告确切 stdin 读取的提供方保留现有路径；报告 inferred idle 的提供方必须呈现本工具安装的确切提示词。原生 Windows 已安装 wheel 包验收仍不可缺少，因为确定性 stub 不会运行 ConPTY 或打包后的运行时。

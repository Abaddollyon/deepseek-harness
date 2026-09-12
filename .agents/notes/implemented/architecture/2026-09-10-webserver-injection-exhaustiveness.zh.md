# Agent Note: Webserver injection rendering invariants

Status: implemented

English | [中文](2026-09-10-webserver-injection-exhaustiveness.md)

## Problem

结构化 webserver 注入渲染器保留了运行时 `assertNever` 回退，以及一个在公开类型和渲染不变量下不可能发生的正文插入条件分支。这些分支降低了逐文件覆盖率，但没有保护可到达的产品路径。

## Decision

`renderRow` 直接切换封闭的 `IndexInjection` 联合类型，不再保留运行时 default。新增行类型时，编译器会要求新增渲染分支。`renderIndexInjections` 在插入前无条件把 `READY_MARKUP` 加入正文累加器，因此正文累加器必定非空；现在直接执行正文标签插入或无正文标签追加。无正文标签追加由公开渲染器测试覆盖，正文标签路径由 WebServer 渲染生命周期覆盖。

## Alternatives considered

**保留运行时 `assertNever`。** 否决，因为该联合类型是封闭的，编译器是要求的变更检测器；没有有效的公开值可以到达该回退。

**保留 `body !== ''` 守卫。** 否决，因为 `READY_MARKUP` 紧接守卫之前无条件追加，使 false 路径不可能发生且守卫不提供额外保护。

**仅为满足覆盖率而修改生产代码。** 否决；只有在源代码不变量证明被删除路径不可到达，并且 README 记录这些不变量后，才接受这个简化。

## Consequences

不支持的未来行类型会在编译期失败，而不是运行时失败。正文插入只有一个无条件路径，所有有效输入的输出保持不变。现有正文标签和无正文标签片段行为仍由专注测试覆盖，webserver 注入源码不再携带不可到达的运行时分支。

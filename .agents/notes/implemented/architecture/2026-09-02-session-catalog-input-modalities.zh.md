# Agent Note: Preserve model input modalities in the Session catalog

Status: implemented

## Problem

Session 模型目录会遗漏适配器报告的输入模态，因此客户端无法区分支持图像的模型和仅支持文本的模型。

## Decision

Session Controller 目录包含 LLM 运行时返回的可选 inputModalities 值。该字段以附加方式提供，缺失值仍表示未知。

## Alternatives considered

**根据模型名称推断图像支持：** 不采用，因为名称不是权威的能力元数据。

**将模态设为必填：** 不采用，因为适配器可能不知道或不会报告能力。

## Consequences

目录消费者可以使用 Host 提供的统一能力列表，同时现有客户端仍兼容省略该字段的响应。

# Agent Note: Settlement notices relay only the child's closing text

Status: implemented

English | [中文](2026-08-25-subagent-settlement-notice-text-only.zh.md)

## Problem

[Manager-owned settlement delivery](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.md) echoes the settling child's final assistant message into a user-role notice to the parent. The terminal output is that message verbatim, so a reasoning model's closing message carried its reasoning blocks with it: the child's private monologue entered the parent's context as user-message content, and a child cut off at its token ceiling mid-thought handed the parent a dangling `Its closing message:` header above reasoning it was never meant to see.

## Decision

`notifySettlement()` filters the terminal output to text blocks immediately before constructing the parent notice. A closing message whose content holds no text reads as no closing message, so the existing `It left no closing message.` fallback covers both a child that produced nothing and one whose final message is reasoning-only. Only the parent-facing echo narrows: `subagent/end.lastAssistantMessage` still carries the full final content for telemetry and UI consumers, and the child's own session log is untouched.

## Alternatives considered

**Filter at output selection (`finalAssistantOutput`).** That selection also feeds `subagent/end.lastAssistantMessage` and backend run results, where the full message is the contract; narrowing there would strip reasoning from telemetry that legitimately observes it.

**Relay reasoning under its own label.** A separate section still adopts the child's private monologue into the parent's context and spends parent tokens on content the child never chose as output; the report tool is the channel for content the child chooses to share.

**Relay only the outcome sentence.** Rejected with [manager-owned settlement delivery](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.md): the closing message is the account a parent acts on when the child never reported.

## Consequences

- A reasoning model's settlement notice costs only the visible answer's tokens in the parent's context.
- Unit coverage pins both shapes: a closing message mixing reasoning and text contributes only the text, and a reasoning-only closing message reads as no closing message.

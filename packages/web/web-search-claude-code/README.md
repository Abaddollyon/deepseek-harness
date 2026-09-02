# @deepseek-ai/dsh-web-search-claude-code

English | [中文](README.zh.md)

## Summary

A Cordis plugin registering the official Claude Agent SDK WebSearch tool as the claude-code provider for ctx.web. Each request owns one ephemeral SDK process and is cleaned up through ctx.subprocess.

## Configuration

Select it with searchProvider: claude-code. Defaults are process.cwd(), a 60-second timeout, 3-second disposal grace, eight sources, four turns, and a 256 KiB payload. Authentication remains in Claude Code. DSH never reads credentials; sign in with claude login. Only WebSearch is enabled, with dontAsk, no session persistence, and structured JSON output.

## Lifecycle

Cancellation, timeout, and fiber disposal terminate the complete subprocess tree. Tests use deterministic SDK-message replays and never perform network searches.

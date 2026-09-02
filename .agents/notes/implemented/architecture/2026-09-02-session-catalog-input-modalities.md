# Agent Note: Preserve model input modalities in the Session catalog

Status: implemented

## Problem

The Session model catalog omitted adapter-reported input modalities, so clients could not distinguish image-capable models from text-only models.

## Decision

The Session Controller catalog includes the optional inputModalities values returned by the LLM runtime. The field is additive and absent values remain unknown.

## Alternatives considered

**Infer image support from model names:** rejected because names are not authoritative capability metadata.

**Make modalities mandatory:** rejected because adapters may not know or report capabilities.

## Consequences

Catalog consumers can use one Host-provided capability list, while existing clients remain compatible with responses that omit the field.

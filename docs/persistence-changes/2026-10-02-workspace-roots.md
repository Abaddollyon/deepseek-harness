---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-workspace-roots

English | [中文](2026-10-02-workspace-roots.zh.md)

## Summary

Adds the workspace/roots event, which records the additional directories a Session may use beside its header cwd.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-workspace-roots
baseline: false
changes:
  - root: "event:workspace/roots"
    previous: null
    after: "1c875e99ac34f443149f4787f2c7dd160981ad48b09c98e18cc5737ae5c02fad"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs never contain the event and keep reading with no additional roots. The writer records it only at seq 0 with ignorable: true, so an older reader skips it and confines the Session to cwd; the model-visible sandbox policy text is logged separately as runtime context, so skipping the event does not change replay of recorded history. The Session header and event envelope are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session/tests/workspace-roots.spec.ts: 3 tests passed.

<a id="dev-note"></a>
## Dev Note

None.

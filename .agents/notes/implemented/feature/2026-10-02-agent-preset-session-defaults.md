# Agent Note: Agent presets declare initial Session defaults

Status: implemented

English | [中文](2026-10-02-agent-preset-session-defaults.zh.md)

## Problem

A preset decides which tools a Session has, but the model route and the permission preset came only from Host defaults. A preset meant for cheap chat or for self-modification therefore started on whatever model and permission the user last used elsewhere, and every Session needed a manual `/model` and permission change before its first turn.

## Decision

A [`dsh-agent-preset`](../../../../packages/preset/agent-preset/README.md) row may declare an optional `defaults` block with a `model` route and a `permission` preset name. The registry returns it from `resolve()` and its roster. The [Session Controller](../../../../packages/api/session-controller/README.md) is the only consumer. After `session.create` makes a new Session, it records the default model as a `model/selection` event, using the `/model` validation path, and switches the permission through `ctx.permissionPresets.set`. When a blank Session changes preset, it moves each value that still equals the replaced preset's default, or the Host default, to the new one. A value that differs counts as an explicit choice and stays. An unusable default logs a warning and leaves the Host default in place.

No event type, header field, or Session format changes. Resumed, adopted, and forked Sessions keep their recorded values. Subagent and workflow children are created outside the Session Controller and keep inheriting the parent's route, permission, and preset revision.

## Alternatives considered

**Read the preset default at each request.** A blank Session would show the Host model in the client while it runs another one, and a config edit would change Sessions that had not started yet. Recording the choice through the existing events keeps the client view and the log consistent.

**Enforce the permission per preset.** Pinning a permission preset that users cannot change is a security policy, which presets explicitly are not. A default keeps the user's ability to choose.

**Fail Session creation on an invalid default.** Provider catalogs change at run time, for example when pool discovery drops a model. Falling back keeps Sessions creatable and leaves the warning in the Host log.

## Consequences

A preset can start its Sessions on its own model and permission without a client change. A user choice that happens to equal the replaced default is indistinguishable from the default and moves with a preset switch. Webhook Sessions name their permission preset and model in the rule result and do not read preset defaults. Focused Session Controller tests cover creation, fallback, blank-Session switching, explicit choices, and adoption of an existing Session.

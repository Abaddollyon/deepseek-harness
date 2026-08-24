# Agent Note: Untitled Sessions Render as Dated New Session Rows

Status: implemented

English | [中文](2026-08-24-untitled-sessions-dated-label.zh.md)

## Problem

A session row's stored display title comes from the client runtime's projection: durable title, then the session cwd's basename, then the raw session id. Sessions without a durable title — logs written before the title service existed, or rows whose title projection has not landed — share their workspace's directory as cwd, so every untitled row under one workspace group rendered the workspace's own name. One group showed five identical rows that all read as the group label, each indistinguishable from the next and each misidentified as the workspace itself.

## Decision

The workspace tree marks a non-blank session row whose summary carries no durable title as `untitled` (`SessionNode.untitled`, derived from `SessionSummary.title === undefined`). The row renderer mirrors the existing blank-row substitution: instead of the stored title — which in this state is only the directory-basename fallback — it renders a dated New Session label (`session.untitled`, "New Session · 2026-08-24 09:32" in en), stamped with the session's last-activity time through the dictionary's date template. The label is meaningful (an unnamed session) and honest about not being a title. Because the stamp has minute precision, the derivation numbers every member of a same-minute collision set (`SessionNode.untitledNumber`, assigned per rendered list in row order; `session.untitledNumbered`, "New Session · 2026-08-24 09:32 (2)" in en), so two untitled sessions in one list never render identical text. The moment the host projects a durable title, the same rows render that title verbatim — including a durable title that legitimately equals the directory name, which never enters the untitled path; search and the copy affordance keep reading the stored title, so nothing else changes.

The runtime projection itself is untouched: `displayTitleOf` is the repo-wide single derivation also consumed by the conversation header and subagent lineage, where the basename remains a reasonable last resort.

## Alternatives considered

**Change the runtime fallback chain to skip the cwd basename.** The basename tier is a deliberate, documented choice shared by every surface that names a session, including the conversation header; removing it would alter surfaces that were never reported broken and still leave the sidebar rows indistinguishable (the id fallback is no more meaningful).

**Fall back to the session's first user message.** The session summary carries no message content; synthesizing a summary in the object layer would duplicate the host title service's fallback, which already writes exactly that title as a durable event for sessions it has folded.

**Use the raw session id as the label.** Distinct, but meaningless to read, and it presents an internal identifier as a title.

## Consequences

- Untitled rows under one group are visually distinct from each other and from the group header, and no row can masquerade as the workspace; same-minute collisions carry an ordinal, so the distinctness guarantee has no gap.
- `SessionNode` gains optional `untitled` and `untitledNumber` fields (absent = false/unnumbered), so existing construction sites are unaffected, and lists without collisions keep their row identities (the derivation returns its input array unchanged).

## Testing

`tree.client.spec.ts` covers the flag's derivation (untitled, titled, and blank rows) and the collision numbering across grouped, flat, and pinned row sets. `rows.client.spec.tsx` covers untitled rows rendering dated labels — numbered on collision — while a titled row renders its stored title. `workspace-browser.client.spec.tsx` covers the assembled regression: a group whose sessions lack durable titles renders non-empty, pairwise-distinct labels and the workspace name exactly once, and durable titles arriving on the same rows restore their real titles, including one that legitimately equals the directory name.

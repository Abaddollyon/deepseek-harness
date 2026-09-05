# Agent Note: narrow settings layout

Status: implemented

English | [中文](2026-09-05-narrow-settings-layout.zh.md)

## Problem

The Settings panel kept its 188px desktop navigation rail beside the content at narrow viewport widths. After the panel inset and content padding, a 390px viewport left roughly 106px for every Settings section. Model controls, delegation configuration, and automation forms were clipped or compressed even though the panel itself remained inside the viewport.

## Decision

At viewport widths up to 640px, the Settings panel uses one column. Its title and section buttons sit in a compact horizontal navigation row above the header and active section. The row scrolls horizontally when contributed sections exceed its width, while the active section retains the panel's vertical scrolling region. The panel uses a 12px viewport inset, and the header keeps the configuration action and Close control inside the same bounded column.

The desktop declarations remain the default: an 800px panel with a 188px navigation rail beside the content. The responsive repair changes presentation only; section registration, selection state, settings values, and focus behavior remain owned by the existing shell and feature components.

## Alternatives considered

**Shrink the desktop rail beside the content.** A narrower rail still consumes scarce horizontal space and truncates both navigation and feature controls. It also makes contributed section counts increasingly fragile.

**Make the panel full-screen on narrow viewports.** A full-screen takeover gives more room but discards the established modal context and changes the visual hierarchy more than the defect requires.

**Hide section labels behind a menu.** A menu saves space but makes section discovery and switching less direct, and introduces new state and interaction behavior for a presentation-only repair.

## Consequences

Every contributed section remains visible as a labeled button and keyboard-reachable in document order. Long navigation sets trade simultaneous visibility for horizontal scrolling. Active section content receives substantially more width, while very tall content continues to scroll inside the bounded panel rather than moving the page behind it.

## Testing

The owner-local stylesheet contract pins the narrow breakpoint, single-column panel, horizontal navigation overflow, vertical content scroll, and unchanged desktop dimensions. The assembled Settings Chrome browser scenario verifies panel bounds, stacked geometry, real keyboard section switching with `aria-current`, reachable header controls, content overflow, Escape closure, restored trigger focus, and a quiet console at a narrow viewport. Its existing desktop ARIA golden remains unchanged.

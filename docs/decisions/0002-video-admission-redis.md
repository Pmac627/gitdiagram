---
type: Decision
title: Video admission on Redis failure
description: Public video generation stops when quota or operator control state is unavailable.
diataxis: explanation
status: draft
date: 2026-09-28
sources:
  - id: entry
    resource: src/app/api/video/generate/route.ts
  - id: limits
    resource: src/server/explainer/limits.ts
  - id: controls
    resource: src/server/admin/controls.ts
generated: { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
tags: [video, quota]
---

# Video admission on Redis failure

## Context

New videos spend model and voice credits.
The public daily budget and live operator controls use Redis.

## Decision in the code

`POST` in `src/app/api/video/generate/route.ts:130` gives a 503 response if it cannot read admission controls.
`reserveVideoSlot` in `src/server/explainer/limits.ts:227` must read quota state before paid work starts.

## Consequences

A Redis outage stops new public video work.
Stored videos stay available through their read paths when storage is available.

---
type: Decision
title: Video admission on Redis failure
description: Superseded. Public video generation stopped when quota or operator control state was unavailable.
diataxis: explanation
status: deprecated
date: 2026-09-28
sources:
  - id: entry
    resource: src/app/api/video/generate/route.ts
  - id: limits
    resource: src/server/explainer/limits.ts
generated: { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T18:00:00Z }
tags: [video, quota]
---

# Video admission on Redis failure

> **Superseded on 2026-09-29** by the private fork. The daily budgets, quota state, and `reserveVideoSlot` are removed. The operator pause control is removed on 2026-09-30.
>
> Admission checks the voice credit. Then it gets a lock and a paid-run position. If the database is not readable, no new video starts.
> See the [explainer video flow](../flows/explainer-video.md) and the [operator dashboard flow](../flows/operator-live-ops.md). This record keeps the initial text for history. See [ADR 0003](0003-self-hosted-single-operator.md) for the current model.

## Context

New videos spend model and voice credits.
The public daily budget and live operator controls use Redis.

## Decision in the code

`POST` in `src/app/api/video/generate/route.ts:100` gave a 503 response if it could not read admission controls.
`reserveVideoSlot` in `src/server/explainer/limits.ts:227` must read quota state before paid work starts.

## Consequences

A Redis outage stops new public video work.
Stored videos stay available through their read paths when storage is available.

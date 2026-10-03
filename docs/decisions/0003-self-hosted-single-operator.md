---
type: Decision
title: Self-hosted single-operator deployment
description: GitDiagram runs for one operator on an IIS host, with SQLite and local disk, provider adapters, and limited outbound traffic.
diataxis: explanation
status: stable
date: 2026-10-01
sources:
  - id: proxy
    resource: src/proxy.ts
  - id: auth
    resource: src/server/auth/**
  - id: db
    resource: src/server/storage/db.ts
  - id: ai
    resource: src/server/ai/**
  - id: next-config
    resource: next.config.js
  - id: web-config
    resource: deploy/iis/web.config
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
verified:
  - { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
tags: [hosting, security, storage, providers]
---

# Self-hosted single-operator deployment

## Context

The upstream project is a public service on Vercel, with Redis, R2, and analytics. The fork must read private and client repositories.
Repository data can go from the host only to GitHub and to the model provider that the operator selects.
The target host is SmarterASP.NET W1050. It has IIS with `httpPlatformHandler`, Node.js 25, and a 1 GB app pool limit.

## Decision

1. **Host.** The app operates as the standalone output of `next.config.js` on IIS. `deploy/iis/web.config` starts `node server.js`. [Deploy to the IIS host](../deployment.md) gives the steps.
2. **One operator.** `proxy` in `src/proxy.ts` and `requireOperator` in `src/server/auth/require-operator.ts` use a signed session cookie for all pages and API routes. A Bearer token gives no access. The app has no public quotas, no per-person budgets, and no geographic rules.
3. **Storage.** `getDb` in `src/server/storage/db.ts:155` opens a SQLite database with the built-in `node:sqlite` module. Artifacts are files in `DATA_DIR`. The app has no Redis, R2, or other cloud store. `DATA_DIR` is `App_Data` on the host, because it is the only writable folder.
4. **Providers.** One adapter for each protocol sits in `src/server/ai/`. `createGenerationProvider` in `src/server/ai/create-provider.ts` selects OpenAI Responses, Anthropic, or OpenAI Chat from `AI_PROVIDER`.
5. **Outbound traffic.** Diagram generation sends requests to GitHub and to the configured provider only. The browser `connect-src` rule is `'self'`. Videos work for public repositories only. They also send requests to their own providers for script, design, and voice.
6. **No MP4 render on the host.** `VIDEO_RENDER_ENABLED` stays unset, so `isVideoRenderEnabled` gives no and the render routes answer 501. The 1 GB pool is too small for Chrome and ffmpeg.
7. **Host limits.** The ARR front end buffers a response below about 8 KB, so the app pads and batches stream events (`SSE_FLUSH_PAD_BYTES`). The host locks some `web.config` sections. TLS uses the host certificate with a DNS only record.

## Consequences

- The app cannot scale out. One process owns the SQLite file, and locks guard overlapped recycles.
- If the `App_Data` folder is gone, all saved results are gone. A changed `CACHE_KEY_SECRET` makes private results unreachable.
- A new provider must have a new adapter or an OpenAI-compatible endpoint.
- The operator must keep the host Node.js release in the `engines` range of `package.json`.

## Relation to earlier records

This record replaces the public admission model of [Video admission on Redis failure](0002-video-admission-redis.md) and the R2 storage of [Private diagram storage](0001-private-diagram-storage.md). The token-derived namespace rule of the first record continues to apply.

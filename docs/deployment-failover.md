---
type: Runbook
title: Offline Railway recovery
description: How to restore GitDiagram on Railway if Vercel cannot serve the site.
diataxis: how-to
status: draft
sources:
  - id: railway-docker
    resource: Dockerfile
  - id: railway-config
    resource: railway.json
  - id: vercel-config
    resource: vercel.json
  - id: next-config
    resource: next.config.js
  - id: readiness
    resource: src/server/readiness.ts
  - id: video-origin
    resource: src/server/explainer/render-origin.ts
  - id: video-audience
    resource: src/server/explainer/audience.ts
  - id: video-limits
    resource: src/server/explainer/limits.ts
  - id: generation-limit
    resource: src/server/generate/rate-limit.ts
  - id: network
    resource: src/lib/network.ts
  - id: env-template
    resource: .env.example
generated: { by: codex/gpt-6-astra, at: 2026-09-28T19:16:06Z }
verified:
  - { by: codex/gpt-6-astra, at: 2026-09-28T19:16:06Z }
---

# Offline Railway recovery

GitDiagram uses `Vercel` for live traffic. The repo has a recovery path for `Railway` and `Docker`.

No Railway service or domain is active for live use. The recovery path does not operate as a standby service.

## Recovery files

The `Dockerfile` sets Next.js output to `standalone` through `RAILWAY_DOCKER_BUILD`. It starts the app with a non-root user.

The image listens on `PORT`, which defaults to `3000`. It installs Debian Chromium for video renders on Railway.

The `railway.json` file sets `/api/healthz` as the health path. `checkReadiness` in `src/server/readiness.ts` checks provider and storage values, each R2 bucket, and Redis.

The recovery service uses the same code and data stores. R2 stores diagram and video files. Upstash Redis stores quotas and locks.

## Restore service

Use these steps during a recovery:

1. Select the production commit. Use the local checks in [Local development setup](dev-setup.md).
2. Select an empty Railway project.
   - For an empty project, use `railway link`.
   - For a new project, use `railway init --name gitdiagram`.
3. Add a service with `railway add --service gitdiagram-api`.
4. Set the service values from `.env.example`.
5. Send each secret through stdin with `railway variable set VARIABLE_NAME --stdin --service gitdiagram-api`.
6. Upload and deploy the checkout with `railway up --service gitdiagram-api`.
7. Add a temporary Railway domain.
8. Check `/api/healthz`, cost estimates, one small generation, cancellation, and saved diagram data.
9. Keep Vercel available during recovery.
10. Move live traffic to Railway after all checks.

`railway up` does not connect the service to GitHub or make a public domain.

Set `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_PRESENCE_URL`, and `NEXT_PUBLIC_VIDEO_EXPLAINER` as Docker `build` arguments. The Dockerfile adds these values to client code.

## Trust limits outside Vercel

The video audience rule reads location headers through `requestGeo` in `src/server/http/vercel-geo.ts`. A client can change these headers on Railway.

The generation and video limits use the client network address. The app reads proxy headers for this address. A client can change these headers behind a proxy that does not replace them.

These controls do not give the same protection on Railway. The daily video limits and complimentary token quota use Upstash.

Before live traffic goes to Railway, change the video audience rule in `/admin`. Set it to `everyone` or pause new video generation. Lower daily limits to decrease spend.

## Return to Vercel

1. Check `https://gitdiagram.com/api/healthz` and one small production generation.
2. Set `gitdiagram.com` to the intended Vercel deployment.
3. Delete temporary Railway domains and the Railway service.
4. Check that Railway has no service and DNS has no Railway record.

The recovery files stay in the repo. They do not start a Railway service or make a public endpoint.

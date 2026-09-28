---
type: Runbook
title: Configuration inventory
description: Environment keys, Worker bindings, defaults, and code consumers.
diataxis: reference
status: draft
sources:
  - id: template
    resource: .env.example
  - id: server
    resource: src/server/**
  - id: routes
    resource: src/app/api/**
  - id: worker
    resource: workers/presence/wrangler.jsonc
  - id: build
    resource: Dockerfile
generated: { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
tags: [configuration, deployment]
---

# Configuration inventory

The app reads values from the Node process environment through `process.env`.
`.env.example` is a template and does not supply runtime values.
The deployment must put necessary keys in the process environment.
Next.js puts `NEXT_PUBLIC_*` values into browser code at build time.
The presence Worker has different values, secrets, and bindings in `workers/presence/wrangler.jsonc`.
No custom configuration loader or ordered provider registration was found in this checkout.

## Core storage and model

`checkReadiness` in `src/server/readiness.ts:24` checks the necessary storage keys and the selected provider key.
`readRequiredEnv` in `src/server/storage/config.ts:17` refuses a missing storage key.

| Key | Default or requirement | Consumer and purpose |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | Must be set | `getClient` in `src/server/storage/r2.ts` makes the R2 endpoint. |
| `R2_ACCESS_KEY_ID` | Must be set | `getClient` authenticates to R2. |
| `R2_SECRET_ACCESS_KEY` | Must be set | `getClient` authenticates to R2. |
| `R2_PUBLIC_BUCKET` | Must be set | `getPublicLocation` selects public artifacts. |
| `R2_PRIVATE_BUCKET` | Must be set | `getPrivateLocation` selects private artifacts. |
| `CACHE_KEY_SECRET` | Must be set | `createPatNamespace` puts private results in caller-token namespaces. |
| `UPSTASH_REDIS_REST_URL` | Must be set | `getBaseUrl` selects the Redis REST endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | Must be set | `getHeaders` authenticates Redis commands. |
| `AI_PROVIDER` | `openai` | `getProvider` selects OpenAI or OpenRouter. |
| `OPENAI_API_KEY` | Must be set for OpenAI provider | `resolveApiKey` supplies model access when the visitor has no key. |
| `OPENROUTER_API_KEY` | Must be set for OpenRouter provider or video voice | `resolveApiKey` and video voice use it. |
| `OPENAI_MODEL` | `gpt-6-luna` | `getModel` selects the OpenAI diagram model. |
| `OPENROUTER_MODEL` | `openai/gpt-5.6-terra` | `getModel` selects the OpenRouter diagram model. |
| `OPENROUTER_SITE_URL` | None | `getOpenRouterHeaders` sends optional site attribution. |
| `OPENROUTER_APP_NAME` | `GitDiagram` | `getOpenRouterHeaders` sends an app title. |

`getProvider` and `getModel` are in `src/server/generate/model-config.ts`.
`resolveApiKey` and `getOpenRouterHeaders` are in `src/server/generate/openai.ts`.

## Diagram quotas and GitHub access

`src/server/generate/complimentary-gate.ts` and `src/server/generate/rate-limit.ts` read these keys.
`src/server/github-auth.ts` reads the GitHub credentials.

| Key | Default or requirement | Purpose |
| --- | --- | --- |
| `OPENAI_COMPLIMENTARY_GATE_ENABLED` | `false` | Enable the daily token gate. |
| `OPENAI_COMPLIMENTARY_DAILY_LIMIT_TOKENS` | `10000000` | Set the daily token limit. |
| `OPENAI_COMPLIMENTARY_MODEL_FAMILY` | `gpt-6-luna` | Select the gated model family. |
| `GENERATION_RATE_LIMIT_MAX` | `8` | Set the host-key generation count for each window. |
| `GENERATION_RATE_LIMIT_WINDOW_SECONDS` | `3600` | Set the host-key window. |
| `GENERATION_INFRASTRUCTURE_RATE_LIMIT_MAX` | `60` | Set the count for all generation callers. |
| `GENERATION_INFRASTRUCTURE_RATE_LIMIT_WINDOW_SECONDS` | `3600` | Set the window for all generation callers. |
| `GITHUB_PAT` | None | Supply one server GitHub token. |
| `GITHUB_PATS` | None | Supply a pool of server GitHub tokens. |
| `GITHUB_APP_ID` | None | Supply a GitHub App JWT issuer. |
| `GITHUB_CLIENT_ID` | None | Supply an alternative GitHub App JWT issuer. |
| `GITHUB_PRIVATE_KEY` | None | Sign a GitHub App JWT. |
| `GITHUB_INSTALLATION_ID` | None | Select the GitHub App installation. |
| `CRON_SECRET` | Must be set for cron endpoint | Authorize `src/app/api/internal/browse-index/drain/route.ts`. |

The GitHub App path must have a private key, an installation ID, and one app issuer ID.
The app can use a server PAT when the App path is missing.

## Analytics and sponsor keys

`src/lib/analytics-client.ts`, `src/server/sponsor-clicks.ts`, and `src/server/sponsor-stats.ts` consume these keys.

| Key | Default or requirement | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_POSTHOG_KEY` | None | Enable browser analytics and sponsor event capture. |
| `POSTHOG_PERSONAL_API_KEY` | None | Read sponsor report data from PostHog. |
| `POSTHOG_PROJECT_ID` | `113380` | Select the PostHog project for reports. |
| `SPONSOR_CLICKS_PER_CAMPAIGN_HOUR` | `5000` | Set an hourly campaign click ceiling. |
| `SPONSOR_IMPRESSIONS_PER_CAMPAIGN_HOUR` | `100000` | Set an hourly campaign view ceiling. |
| `SPONSOR_PREVIEW_CAMPAIGN` | None | Select a preview campaign on a non-production host. |

## Video models and admission

`src/server/explainer/config.ts`, `planner.ts`, and `limits.ts` consume these keys.
The two video flags must be `1` to show video controls in the browser and let visitors make videos.

| Key | Default or requirement | Purpose |
| --- | --- | --- |
| `VIDEO_EXPLAINER_ENABLED` | Off | Let the server accept video generation. |
| `NEXT_PUBLIC_VIDEO_EXPLAINER` | Off | Show browser video UI. |
| `ANTHROPIC_API_KEY` | None | Supply access when a Claude model is selected. |
| `VIDEO_PLANNER_MODEL` | `claude-opus-5-5` | Select the premium planner. |
| `VIDEO_PLANNER_EFFORT` | `low` | Set planner effort. |
| `VIDEO_PREMIUM_OPUS_DESIGNS` | Off | Let Opus design premium scenes. |
| `VIDEO_STANDARD_MODEL` | `gpt-6-sol` | Select the standard designer. |
| `VIDEO_STANDARD_EFFORT` | `medium` | Set standard model effort. |
| `VIDEO_STANDARD_DIRECTOR_MODEL` | `claude-opus-5-5` | Select the standard script writer. |
| `VIDEO_PREMIUM_MIN_STARS` | `10000` | Set the repository star threshold for premium work. |
| `VIDEO_STORE` | `local` when production is off, `r2` in production | Select video artifact storage. |
| `VIDEO_DAILY_LIMIT` | `25` | Limit new videos for each UTC day. |
| `VIDEO_PERSON_DAILY_LIMIT` | `1` | Limit new videos for each visitor. |
| `VIDEO_PRIORITY_PERSON_DAILY_LIMIT` | `3` | Set the limit for a visitor with `priority` access. |
| `VIDEO_PREMIUM_PERSON_DAILY_LIMIT` | `1` | Limit premium work for each visitor. |
| `VIDEO_PREMIUM_NETWORK_DAILY_LIMIT` | Two times the person limit | Limit premium work for each network. |
| `VIDEO_NETWORK_DAILY_LIMIT` | `10` | Limit new videos for each network. |
| `VIDEO_NETWORK_ATTEMPT_LIMIT` | `10` | Limit starts for each network window. |
| `VIDEO_NETWORK_ATTEMPT_WINDOW_SECONDS` | `3600` | Set the start window. |
| `VIDEO_MAX_PAID_RUNS` | `10` | Limit concurrent paid video work. |
| `VIDEO_RENDER_DAILY_LIMIT` | `300` | Limit new MP4 renders for each day. |
| `VIDEO_RENDER_PERSON_DAILY_LIMIT` | `8` | Limit new renders for each visitor. |
| `VIDEO_RENDER_NETWORK_DAILY_LIMIT` | `40` | Limit new renders for each network. |

## Video render and operator keys

`src/server/explainer/render.ts`, `segments.ts`, and `render-origin.ts` use render values.
`src/server/admin/operator.ts` uses the operator token.

| Key | Default or requirement | Purpose |
| --- | --- | --- |
| `VIDEO_ADMIN_TOKEN` | None, minimum 32 characters when set | Sign in the operator and bypass public video limits. |
| `ANTHROPIC_ADMIN_KEY` | None | Read Claude credit data for the admin page. |
| `VIDEO_RENDER_CHROME_PATH` | Runtime Chrome selection | Select a Chromium binary. |
| `VIDEO_RENDER_CHROME_ARGS` | None | Supply Chromium arguments. |
| `VIDEO_SEGMENT_FAN_OUT` | `10` | Set concurrent render segment requests. |
| `VIDEO_SEGMENT_CONCURRENCY` | `2` in production | Limit segment work in one instance. |
| `VIDEO_INTERNAL_ORIGIN` | Request origin or local container origin | Select the app origin for internal render requests. |
| `VIDEO_PREVIEW_PAUSED` | None | Show a paused preview in development. |
| `NEXT_PUBLIC_PRESENCE_URL` | None | Connect browser presence and configure the CSP. |
| `PRESENCE_SECRET` | None | Authenticate app and Worker feed messages. |

`renderLimit` in `src/app/api/video/render/segment/route.ts:30` reads `VIDEO_SEGMENT_CONCURRENCY`.

## Worker bindings and platform values

`workers/presence/wrangler.jsonc` supplies `ALLOWED_ORIGINS`, `SITE_ORIGIN`, `CONNECTS`, and `PRESENCE`.
The Worker reads the `PRESENCE_SECRET` deployment secret through its own `env` binding.
`ALLOWED_ORIGINS` limits visitor sockets, and `SITE_ORIGIN` selects the app feed origin.
`CONNECTS` limits new sockets, and `PRESENCE` names the Durable Object.

| Key | Source | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Node runtime | Select production, test, or development behavior. |
| `NEXT_PHASE` | Next.js build | Let the catalog use a fallback during the build. |
| `PORT` | Container or runtime | Select the local HTTP port for internal render requests. |
| `VERCEL` | Vercel runtime | Select Vercel render behavior. |
| `VERCEL_DEPLOYMENT_ID` | Vercel runtime | Identify a video render deployment. |
| `VERCEL_GIT_COMMIT_SHA` | Vercel runtime | Show the admin build commit. |
| `VERCEL_REGION` | Vercel runtime | Show the admin region. |
| `RAILWAY_DOCKER_BUILD` | `Dockerfile` | Enable Next.js standalone output. |
| `NEXT_TELEMETRY_DISABLED` | `Dockerfile` | Disable Next.js telemetry in the image. |
| `HOSTNAME` | `Dockerfile` | Set the container server address. |
| `ALLOW_LIVE_STORAGE_IN_TESTS` | Test environment | Let tests use live storage when set to `1`. |
| `REDIS_TEST_URL` | Test environment | Select a local Redis test service. |

The experiments also read `STAGE_ORIGIN`, `STAGE_ROOT`, `HOME`, and `PORT`.
Those values change only the scripts in `experiments/`.

## Source review

The key inventory covers `.env.example`, `process.env` reads in `src/`, Worker bindings, and deployment files.
All keys in the inventory come from the process environment, a platform value, or a Worker binding.

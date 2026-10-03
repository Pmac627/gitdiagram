---
type: Runbook
title: Configuration inventory
description: Environment keys, defaults, and code consumers.
diataxis: reference
status: draft
sources:
  - id: template
    resource: .env.example
  - id: server
    resource: src/server/**
  - id: routes
    resource: src/app/api/**
  - id: credentials-client
    resource: src/features/credentials/**
  - id: next-config
    resource: next.config.js
  - id: web-config
    resource: deploy/iis/web.config
  - id: site
    resource: src/lib/site.ts
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T12:00:00Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T18:00:00Z }
  - { by: codex/gpt-6, at: 2026-09-29T22:01:56Z }
  - { by: codex/gpt-6, at: 2026-09-30T16:53:04Z }
  - { by: codex/gpt-6, at: 2026-09-30T18:10:00Z }
  - { by: codex/gpt-6, at: 2026-09-30T17:28:08Z }
  - { by: codex/gpt-6, at: 2026-09-30T17:46:31Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-30T18:45:00Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
tags: [configuration, deployment]
---

# Configuration inventory

The app reads values from the Node process environment through `process.env`.
`.env.example` is a template and does not supply runtime values.
The deployment must put necessary keys in the process environment.
Next.js puts `NEXT_PUBLIC_*` values into browser code at build time.
No custom configuration loader or ordered provider registration was found in this checkout.

The private fork removed the keys for Cloudflare R2, the daily token gate, the rate limiters, the video budgets, and operator sign-in Redis.
It also removed the cron endpoint key and the video store selector.
The code does not read a key that this page does not show.
The template no longer has the keys `OPENAI_MODEL`, `OPENROUTER_MODEL`, `OPENROUTER_SITE_URL`, and `OPENROUTER_APP_NAME`, which had no consumer.

## Core storage and model

`checkReadiness` in `src/server/readiness.ts:65` checks `DATA_DIR`, `CACHE_KEY_SECRET`, provider, model, endpoint, and API key values.
It checks the database and writes to `DATA_DIR` only when the necessary values are valid.
`readRequiredEnv` in `src/server/storage/config.ts:6` gives an error when a necessary key has no value.

| Key                                                            | Default or rule                                                                                 | Consumer and purpose                                                                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATA_DIR`                                                     | Necessary                                                                                       | `getDataDir` in `src/server/storage/db.ts:65` selects the folder for `gitdiagram.db`, `objects`, `video`, and `tmp`.                                               |
| `CACHE_KEY_SECRET`                                             | Necessary                                                                                       | `createPatNamespace` puts private results in caller-token namespaces. `signingKey` in `src/server/explainer/segments.ts` derives the signing key for segment work. |
| `OPERATOR_TOKEN`                                               | 40 or more characters                                                                           | `operatorToken` in `src/server/auth/operator.ts` signs operator sessions and gives operator access.                                                                |
| `VIDEO_ADMIN_TOKEN`                                            | None, legacy fallback for one release                                                           | `operatorToken` uses this value only when `OPERATOR_TOKEN` is empty.                                                                                               |
| `AI_PROVIDER`                                                  | `openai`                                                                                        | `getProvider` accepts `openai`, `anthropic`, `gemini`, `grok`, or `openai-compatible`.                                                                             |
| `AI_API_KEY`                                                   | Necessary for readiness                                                                         | `getApiKey` reads this key. `createGenerationProvider` uses it for the selected provider.                                                                          |
| `AI_MODEL`                                                     | `gpt-6-luna` for OpenAI. Necessary for other providers.                                         | `getModel` reads the model for the selected provider.                                                                                                              |
| `AI_BASE_URL`                                                  | None for OpenAI or Anthropic. Gemini and Grok have defaults. Necessary for `openai-compatible`. | `getBaseUrl` validates an endpoint override. It accepts HTTPS, or HTTP for localhost.                                                                              |
| `OPENAI_API_KEY`                                               | None for diagram generation. Video code can read it                                             | Diagram generation uses `AI_API_KEY` or a caller key. Video code reads `OPENAI_API_KEY` for its OpenAI requests.                                                   |
| `OPENROUTER_API_KEY`                                           | Necessary for video voice                                                                       | Video voice reads this key. OpenRouter is no longer a diagram provider.                                                                                            |

`getProvider`, `getModel`, `getApiKey`, and `getBaseUrl` are in `src/server/generate/model-config.ts`.
`createGenerationProvider` in `src/server/ai/create-provider.ts` selects the adapter used by the generation stream and cost routes.
`resolvePricingModel` in `src/server/generate/pricing.ts` checks rates for the selected provider and model. The current rate table covers OpenAI models.

Unknown and local model IDs have no USD rate. The stream and cost routes continue and report cost as `n/a` while they keep token counts.
The cost route uses provider token counts when available. It uses a local token estimate when no counter works.
A known price is not necessary for these routes.

`DATA_DIR` has no default. `getDataDir` gives an error when it has no value.
On the SmarterASP host, `deploy/iis/web.config` sets `DATA_DIR` to `App_Data`, a path that is relative to the site root. IIS does not send files from that folder.

## Caller API key

A visitor can save an own API key in the `gitdiagram_openai_api_key` cookie.
`setCredential` in `src/server/http/request-credentials.ts` stores the key with the provider it is for, in a JSON wrapper.
The provider must be one of `AI_PROVIDERS` from `src/server/generate/model-config.ts`. `setCredential` rejects a missing or unknown provider.
For `openai-compatible`, `setCredential` also stores the `AI_BASE_URL` value that `getBaseUrl` gives at save time. The browser does not send an endpoint.

`readApplicableApiKey` gives the key only when the stored provider is the same as the `AI_PROVIDER` value from `getProvider`.
For `openai-compatible`, the stored endpoint must also be the same as the endpoint at this time.
`resolveRequestCredentials` and `getCredentialStatus` use this rule. The app does not send a key for a different provider to the configured endpoint.
The key applies again if the server goes back to the provider that the key is for.

`readBoundApiKey` ignores a cookie that has no provider tag. A visitor must enter such a key again.
`migrateLegacyCredentialStorage` in `src/features/credentials/api.ts` removes a legacy `openai_api_key` value from browser storage and does not upload it. It continues to move `github_pat`.

`CredentialStatus` has two provider fields. `configuredProvider` is the provider of the server. `apiKeyProvider` is the provider of the stored key, or null.
`ApiKeyDialog` in `src/components/api-key-dialog.tsx` shows the name of `configuredProvider` and a notice when the stored key does not apply.
The status does not contain the key.

Use an operator token of 40 characters or more. The app uses it to sign browser sessions. The app does not accept it as a Bearer token.

SQLite stores the session generation, a random installation nonce, and the global counter for incorrect tokens. If SQLite cannot read or update this counter, the app stops sign-in.

## GitHub access

`src/server/github-auth.ts` reads the GitHub credentials.
The diagram routes have no daily token gate and no generation rate limiter.

| Key                      | Default or requirement | Purpose                                      |
| ------------------------ | ---------------------- | -------------------------------------------- |
| `GITHUB_PAT`             | None                   | Supply one server GitHub token.              |
| `GITHUB_PATS`            | None                   | Supply a pool of server GitHub tokens.       |
| `GITHUB_APP_ID`          | None                   | Supply a GitHub App JWT issuer.              |
| `GITHUB_CLIENT_ID`       | None                   | Supply an alternative GitHub App JWT issuer. |
| `GITHUB_PRIVATE_KEY`     | None                   | Sign a GitHub App JWT.                       |
| `GITHUB_INSTALLATION_ID` | None                   | Select the GitHub App installation.          |

The GitHub App path must have a private key, an installation ID, and one app issuer ID.
The app can use a server PAT when the App path is missing.

## Video models

`src/server/explainer/config.ts`, `planner.ts`, and `limits.ts` consume these keys.
The two video flags must be `1` to show video controls in the browser and let visitors make videos.

| Key                             | Default or requirement | Purpose                                                                                     |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `VIDEO_EXPLAINER_ENABLED`       | Off                    | Let the server accept video generation.                                                     |
| `NEXT_PUBLIC_VIDEO_EXPLAINER`   | Off                    | Show browser video UI.                                                                      |
| `ANTHROPIC_API_KEY`             | None                   | Supply access when a Claude model is selected.                                              |
| `VIDEO_PLANNER_MODEL`           | `claude-opus-5-5`      | Select the premium planner.                                                                 |
| `VIDEO_PLANNER_EFFORT`          | `low`                  | Set planner effort.                                                                         |
| `VIDEO_PREMIUM_OPUS_DESIGNS`    | Off                    | Let Opus design premium scenes.                                                             |
| `VIDEO_STANDARD_MODEL`          | `gpt-6-sol`            | Select the standard designer.                                                               |
| `VIDEO_STANDARD_EFFORT`         | `medium`               | Set standard model effort.                                                                  |
| `VIDEO_STANDARD_DIRECTOR_MODEL` | `claude-opus-5-5`      | Select the standard script writer.                                                          |
| `VIDEO_PREMIUM_MIN_STARS`       | `10000`                | Set the repository star threshold for premium work.                                         |
| `VIDEO_MAX_PAID_RUNS`           | `10`                   | `tryPaidVideoRun` in `src/server/explainer/limits.ts:45` limits concurrent paid video work. |

`choosePlanner` in `src/server/explainer/planner.ts:89` gives the premium planner to the operator and to a repository that has `VIDEO_PREMIUM_MIN_STARS` stars or more.
No other rule selects the premium planner. The app has no per-person, daily, or network limits.

## Video render and operator keys

`src/server/explainer/render.ts`, `segments.ts`, and `render-origin.ts` use render values.
`src/server/auth/operator.ts` uses the operator token.

| Key                         | Default or requirement               | Purpose                                              |
| --------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `VIDEO_RENDER_ENABLED`      | Off. The value `1` sets it              | Start MP4 render and posters.                      |
| `VIDEO_RENDER_CHROME_PATH`  | Necessary for render                 | Select a Chromium binary.                            |
| `VIDEO_RENDER_CHROME_ARGS`  | None                                 | Supply Chromium arguments.                           |
| `VIDEO_SEGMENT_FAN_OUT`     | `10`                                 | Set concurrent render segment requests.              |
| `VIDEO_SEGMENT_CONCURRENCY` | `1` in production                    | Limit segment work in one instance.                  |
| `VIDEO_INTERNAL_ORIGIN`     | Request origin or loopback origin    | Select the app origin for internal render requests.  |
| `VIDEO_PREVIEW_PAUSED`      | None                                 | Set `limit` to show a paused preview in development. |

`renderLimit` in `src/app/api/video/render/segment/route.ts:33` reads `VIDEO_SEGMENT_CONCURRENCY`.
The values `audience` and `device` of `VIDEO_PREVIEW_PAUSED` are removed.
`isVideoRenderEnabled` in `src/server/explainer/config.ts:12` reads `VIDEO_RENDER_ENABLED`. Only the value `1` turns on render.

When render is off, the render route and the segment route give status 501. The generation route makes no poster.
`GET` in `src/app/api/video/route.ts:58` sends `renderEnabled`. The share row shows the MP4 and README picture buttons only if `renderEnabled` is `true`.

## Platform values

| Key                           | Source                    | Purpose                                                                                                                                                             |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | Node runtime              | Select production, test, or development behavior.                                                                                                                   |
| `NEXT_PHASE`                  | Next.js build             | Let the catalog use a fallback during the build.                                                                                                                    |
| `PORT`                        | Host runtime              | `internalOrigin` in `src/server/explainer/render-origin.ts:15` builds the loopback origin. The host can pad the value with spaces.                                  |
| `SSE_FLUSH_PAD_BYTES`         | `0`, range `0` to `65536` | `getSseFlushPadBytes` in `src/app/api/generate/stream/route.ts` selects the minimum byte count for padded stream batches. Set it to `9216` in the host environment. |

The experiments also read `STAGE_ORIGIN`, `STAGE_ROOT`, `HOME`, and `PORT`.
Those values change only the scripts in `experiments/`.

## Build and site values

`SITE_URL` in `src/lib/site.ts` is a constant, not an environment key. Its value is `https://gitdiagram.tuple.pro`. Metadata, share addresses, and social images use it.
Change the constant to move the site.

`next.config.js` always sets `output: "standalone"`. The key `RAILWAY_DOCKER_BUILD` is removed, and the code reads no `VERCEL_*` key.
The `engines` field of `package.json` accepts Node.js `>=24 <26` and Bun `>=1.3.14 <2`.

The app has no star reminder and sends no request for the GitHub star count.
The key `VIDEO_PREMIUM_MIN_STARS` continues to read the star count of the repository that a video covers.
The page [Deploy to the IIS host](deployment.md) lists the host values.

## Source review

The key inventory covers `.env.example`, `process.env` reads in `src/`, and `next.config.js`.
All keys in the inventory come from the process environment, or a platform value.
The removed keys are the `R2_*` keys, `VIDEO_STORE`, `CRON_SECRET`, the `OPENAI_COMPLIMENTARY_*` keys, the `GENERATION_*RATE_LIMIT*` keys, the `UPSTASH_*` keys, and `REDIS_TEST_URL`.
The removed keys also include the daily, person, network, and render limit keys of video.

---
type: Runbook
title: Local development setup
description: How to install, configure, and operate GitDiagram on a local machine.
diataxis: how-to
status: draft
sources:
  - id: app-setup
    resource: package.json
  - id: env-template
    resource: .env.example
  - id: app-config
    resource: src/server/**
  - id: app-routes
    resource: src/app/**
  - id: next-config
    resource: next.config.js
  - id: ci
    resource: .github/workflows/ci.yml
  - id: package-script
    resource: scripts/package-iis.ps1
  - id: dev-script
    resource: scripts/dev-turbo.sh
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
verified:
  - { by: codex/gpt-6-astra, at: 2026-09-28T19:16:06Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T12:00:00Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T18:00:00Z }
  - { by: codex/gpt-6, at: 2026-09-29T22:01:56Z }
  - { by: codex/gpt-6, at: 2026-09-30T16:53:04Z }
  - { by: codex/gpt-6, at: 2026-09-30T18:10:00Z }
  - { by: codex/gpt-6, at: 2026-09-30T17:28:08Z }
  - { by: codex/gpt-6, at: 2026-09-30T17:46:31Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
---

# Local development setup

GitDiagram uses one Next.js app. The UI and API use the same server.
The app uses no cloud service for storage. It saves all state in one local folder.

## Prerequisites

- Install a Node.js release that has the built-in `node:sqlite` module, and Bun 1.3.14. `package.json` sets the `Node.js` and `Bun` versions.
- Use Node.js 24 on the development machine. The host operates Node.js 25. The `engines` field of `package.json` accepts the two releases (`>=24 <26`).
- Use Node.js for lint, type checks, and tests. CI uses Node for these tasks.
- Use Bun for package install, the app, and `bun run build`.

```sh
node --version
bun --version
```

## Install

```sh
bun install
cp .env.example .env
```

Use `bun ci` to install the pinned packages in `bun.lock`.

The `prepare` script sets `.githooks` as the path for the pre-push file. The `pre-push` check checks format, lint, types, and `knip`.

## Configure

The app reads environment values through `process.env`. Next.js loads local `.env` files. No custom provider reads JSON or YAML.

Set the data folder and the cache secret. `checkReadiness` in `src/server/readiness.ts:65` validates provider values before it checks local storage.

```dotenv
DATA_DIR=
CACHE_KEY_SECRET=
OPERATOR_TOKEN=
```

`DATA_DIR` is a folder that is not in the repository. `getDb` in `src/server/storage/db.ts:141` makes the folder and the database `gitdiagram.db` on first use.
Do not set `DATA_DIR` to a folder that the web server sends to browsers.

Set `OPERATOR_TOKEN` to a secret with 40 or more characters. The app uses it for browser sessions only. A Bearer token gives no access.
`checkSignIn` in `src/server/auth/sign-in-guard.ts` counts incorrect token tries in SQLite. It stops sign-in if the database cannot read or update the counter.

The `/sign-in` page lets the operator make or end a session. All pages and API routes use a session.
The sign-in flow and static assets in `video-engine` work without a session. Use the sign-out control to end the current session, or end all sessions from `/admin`.

Select a provider. `getProvider` in `src/server/generate/model-config.ts` selects OpenAI by default.

```dotenv
AI_PROVIDER=openai
AI_API_KEY=
AI_MODEL=gpt-6-luna
AI_BASE_URL=
OPENAI_API_KEY=
```

The model configuration accepts `openai`, `anthropic`, `gemini`, `grok`, and `openai-compatible`. The routes use the adapter for the selected provider.
Set `AI_API_KEY` for the selected provider.
OpenAI uses `gpt-6-luna` when `AI_MODEL` has no value. Set `AI_MODEL` for each other provider.

Set `AI_BASE_URL` for an OpenAI-compatible service, such as LM Studio.
Use HTTPS, or HTTP for localhost.

- OpenAI uses the Responses adapter. Anthropic uses its Messages adapter.
- Gemini, Grok, and compatible services use the OpenAI Chat adapter.
- Pricing uses the selected provider and model. The current rate table covers OpenAI models.
- An unknown or local model can show token counts and cost `n/a`. The stream and cost routes continue without a known price.
- The cost route uses provider token counts when available. It uses a local estimate when no counter works.

Set `SSE_FLUSH_PAD_BYTES=9216` in the host environment. The default is `0`, which disables padding.
The route accepts integer values from `0` to `65536`. Padded batches can help the host send stream events without buffering.

The video voice path uses `OPENROUTER_API_KEY`.
See `.env.example` for video values.

Set `VIDEO_EXPLAINER_ENABLED` and `NEXT_PUBLIC_VIDEO_EXPLAINER` to `1` to enable video. Video uses `OPENAI_API_KEY` and `OPENROUTER_API_KEY`. A Claude model uses `ANTHROPIC_API_KEY`.

## Operate

```sh
bun run dev
```

The app uses `http://localhost:3000` by default. The `dev` script starts Next.js with Turbopack.

For a production-mode local check, use:

```sh
bun run build
bun run start
```

The `start` script operates the Next.js server. The app has no second API process.

## Check

```sh
bun run lint
bun run typecheck
bun run format:check
bun run knip
bun audit
bun run test
bun run build
bun run check:video-tracing
bun run perf:budget
```

Storage tests use a temporary `DATA_DIR`. `createTempDataDir` in `src/server/storage/test-data-dir.ts` makes and removes it.
The auth tests use a temporary `DATA_DIR` for session generations and wrong-token counts.
CI checks the app. CI has no container build task and no other package.

## Package and deploy

```sh
bun run package:iis
```

This command runs `scripts/package-iis.ps1`. It must run on Windows x64. It builds the app and writes a zip of the standalone output in `artifacts/`.

Set `NEXT_PUBLIC_VIDEO_EXPLAINER=1` before the build if you want video controls.
The package holds no `.env` file and no secret.
See [Deploy to the IIS host](deployment.md) for the upload steps and the host values.
The repository has no Vercel or Railway files, no `Dockerfile`, and no CI container build task.

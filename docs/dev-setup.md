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
  - id: dev-script
    resource: scripts/dev-turbo.sh
generated: { by: codex/gpt-6-astra, at: 2026-09-28T19:16:06Z }
verified:
  - { by: codex/gpt-6-astra, at: 2026-09-28T19:16:06Z }
---

# Local development setup

GitDiagram uses one Next.js app. The UI and API use the same server.

## Prerequisites

- Install Node.js 22 and Bun 1.3.14. `package.json` sets `Node.js` and `Bun` versions.
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

Set these storage and Redis values. `checkReadiness` in `src/server/readiness.ts` checks each value and each bucket.

```dotenv
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_BUCKET=
R2_PRIVATE_BUCKET=
CACHE_KEY_SECRET=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Select a provider. `getProvider` in `src/server/generate/model-config.ts` selects OpenAI by default.

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=
```

Set `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY` to use OpenRouter. See `.env.example` for all other values.

Set `VIDEO_EXPLAINER_ENABLED` and `NEXT_PUBLIC_VIDEO_EXPLAINER` to `1` to enable video. Video uses `OPENAI_API_KEY` and `OPENROUTER_API_KEY`. A Claude model uses `ANTHROPIC_API_KEY`.

Set `NEXT_PUBLIC_PRESENCE_URL` and `PRESENCE_SECRET` to connect the site to the Cloudflare presence Worker. Read [the Worker README](../workers/presence/README.md).

The Worker reads `ALLOWED_ORIGINS`, `SITE_ORIGIN`, and bindings from `workers/presence/wrangler.jsonc`. Set `PRESENCE_SECRET` with Wrangler.

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

CI checks the app and makes its Docker image. CI checks the Worker from `workers/presence` with its lockfile.

Use `bun ci`, `bun run typecheck`, `bun run test`, and `bun audit` in `workers/presence` to check the Worker.

## Deploy

Vercel is the live deployment target. Set the values that the Vercel project uses, then deploy with:

```sh
vercel deploy
vercel deploy --prod
```

The `vercel.json` file sets the Bun version, a browse-index cron with schedule `*/5 * * * *`, and video segment limits.

The `Dockerfile` and `railway.json` files set the Railway recovery path. Supply the `NEXT_PUBLIC_*` values as Docker arguments. Next.js adds these values to client code at `build` time.

The container uses `3000` by default. It uses `PORT` when the host sets it. Use `VIDEO_INTERNAL_ORIGIN` only for a different local URL.

See [Offline Railway recovery](deployment-failover.md) for the recovery steps.

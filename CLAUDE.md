# CLAUDE.md

This file guides Claude Code (claude.ai/code) in this repository.

## What this is

A private, self-hosted fork of GitDiagram for one operator. It turns a GitHub repository (private ones included) into an interactive Mermaid architecture diagram, and can make explainer videos for public repositories. It is **one Next.js 16 App Router app** (React 19, TypeScript, Tailwind 4). The API is Route Handlers in `src/app/api/`. Bun is the package manager and build runner; **production runs on Node** (24 or 25, `engines` is `>=24 <26`).

Production host: SmarterASP.NET W1050 (IIS, httpPlatformHandler, 1 GB app pool, Node 25) at `https://gitdiagram.tuple.pro`. The upstream Vercel, Redis, R2, PostHog, sponsor and presence-Worker code is gone.

`plans/private-fork.md` is the work tracker shared with Codex. Read it first, tick steps there, and add a handoff log entry before you stop. The Professor commits, pushes and merges; agents do not.

## Commands

```bash
bun run dev                  # dev server (Turbopack) at localhost:3000
bun run test                 # all tests (vitest run); one file: bun run test <path>
bun run lint                 # eslint, fails on any warning
bun run typecheck            # TypeScript 7 tsc --noEmit
bun run check                # lint + typecheck
bun run format:check         # prettier (ts/js/mdx/css/json/yaml; not Markdown)
bun run knip                 # unused files, exports, dependencies
bun run build                # production build (standalone output)
bun run check:video-tracing  # after build: ffmpeg traced only where needed, size ceilings
bun run perf:budget          # after build: bundle budgets
bun run package:iis          # build and zip the standalone output for the IIS host (Windows x64)
```

This machine (Windows, Git Bash and PowerShell):

- Typecheck with `node node_modules/typescript-7/bin/tsc --noEmit`; the bun shim fails. Delete a stale `tsconfig.tsbuildinfo` if tsc shows phantom errors.
- Install with `bunx bun@1.3.14 install` (Bun 1.4 rewrites `bun.lock`).
- Do not run `python3` (a Store stub that hangs; real Python is `python`), `cmd.exe /c` from Git Bash (hangs), or `npx`. Run checks in the foreground.
- Ripwire: from PowerShell run `ripwire . --doc-drift`.
- Full gate: lint, typecheck, format:check, knip, test, build, check:video-tracing, perf:budget.

Vitest runs two projects (`vitest.config.ts`): **server** (`src/server/**`, `src/app/api/**`, `node` env, `vitest.server-setup.ts` stubs `server-only`) and **client** (everything else, jsdom). Tests sit beside the code as `*.test.ts(x)`. Server tests use a temp `DATA_DIR` (`createTempDataDir` in `src/server/storage/test-data-dir.ts`). Alias `~` is `src/`.

## Architecture

Docs are the map; read them instead of re-deriving the code: `docs/index.md`, `docs/architecture.md`, `docs/flows/`, `docs/configuration.md`, `docs/deployment.md`, `docs/decisions/0003-self-hosted-single-operator.md`.

- **Generation** (`src/server/generate/`, `src/server/ai/`): `/api/generate/stream` ingests the repo from GitHub, selects bounded source excerpts (secret-scanned), streams an explanation, asks the model for a strict graph AST, validates it (`graph.ts`), and compiles it to Mermaid deterministically. `src/server/ai/` holds one adapter per protocol (OpenAI Responses, Anthropic, OpenAI Chat) behind `provider.ts`; `AI_PROVIDER` selects it. The SSE writer pads and batches flushes (`SSE_FLUSH_PAD_BYTES`, 9216 on the host) and sends heartbeats. `mermaid-validator.ts` is test-only; never import it in production code.
- **Client rendering** (`src/components/mermaid-diagram.tsx`, `src/features/diagram/mermaid-security.ts`): sanitize source, render with `securityLevel: "antiscript"` and `htmlLabels: false`, sanitize the SVG with DOMPurify, then re-enforce the GitHub-only link allowlist.
- **Storage** (`src/server/storage/`): SQLite through built-in `node:sqlite` (`db.ts`, migrations append-only) plus files under `DATA_DIR/objects` and `DATA_DIR/video`. No cloud store. `DATA_DIR` is required (`App_Data` on the host). Private results use a namespace derived from `CACHE_KEY_SECRET` and the caller token; never change that secret.
- **Videos** (`src/server/explainer/`, `src/features/explainer/`, `public/video-engine/`): public repos only, gated by `VIDEO_EXPLAINER_ENABLED` and `NEXT_PUBLIC_VIDEO_EXPLAINER` (build time). MP4 render is off unless `VIDEO_RENDER_ENABLED=1` (routes answer 501; off on the host). Bump `ENGINE_VERSION` (`src/features/explainer/engine.ts`) and every `?v=` in `stage.html` and `engine.css` with any change under `public/video-engine`.
- **Auth** (`src/proxy.ts`, `src/server/auth/`): one operator gates every page and API route.
- **Layers**: `src/server/` is server-only (`import "server-only"`); `src/features/` is shared and client domain logic; `src/hooks/` runs the client generation lifecycle; `src/app/` holds pages and routes.
- **Packaging**: `output: "standalone"` in `next.config.js`; `outputFileTracingExcludes` keeps `src/**` out; `scripts/package-iis.ps1` and `deploy/iis/web.config` make the host package. `deploy/spike/` is the finished host probe, not part of the app.

## Security invariants

Do not weaken these; tests guard them.

- **Operator gate**: `proxy` in `src/proxy.ts` needs a verified session cookie for everything except `_next/static`, `_next/image`, `favicon.ico`, `/video-engine/*`, `/sign-in`, `/api/auth/*` and `/api/healthz` (minimal answer when anonymous). Every sensitive route handler also calls `requireOperator` (`src/server/auth/require-operator.ts`). **Cookie sessions only: no Bearer token.** The segment route keeps its own HMAC job signature. Wrong tokens hit a global SQLite counter (`sign-in-guard.ts`); the session store fails closed when SQLite is unreadable. `OPERATOR_TOKEN` is 40+ characters.
- **Secrets never leak**: logs and error text pass through `redactLogText` and `errorText` (`src/server/log.ts`); source and README text pass through `redactSecrets` (`src/server/generate/secret-scan.ts`) before it enters a prompt. Never log a token, key or IP. Never commit `.env*`, tokens or the probe token.
- **Egress**: diagram generation talks only to GitHub and the configured AI provider; the browser CSP `connect-src` is `'self'`. Videos also use their own provider keys and OpenRouter voice (`voice.ts` is the only `openrouter.ai` user). A caller API key cookie is bound to its provider (and endpoint for `openai-compatible`). `fork-isolation.test.ts` scans for removed services; do not reintroduce them.
- **Responses are `private`/`no-store`**, never `public` or `s-maxage` (Cloudflare may front the host). Pages are `noindex`; `robots.ts` disallows all; HSTS is set in `next.config.js`.
- **Diagram output** is defense in depth: server validation, deterministic compiler, client sanitization. A change to one layer must keep the others intact (`mermaid-security.test.ts` and the compiler contract tests).
- **Object keys** are lowercase and validated (`fs-safety.ts`, `object-store.ts`): no `..`, drive letters, NUL or Windows device names.

## Conventions

- Prettier with `prettier-plugin-tailwindcss` (`bun run format:write`); ESLint 10 flat config. `deploy/**` and `experiments/**` are outside lint, knip and typecheck.
- Server code stays under `src/server/` behind `server-only`. No new dependencies without asking.
- Tests first: write failing unit tests, then implement. No live services in tests.
- Docs are part of done: update `docs/` with the anchored-docs skill after any code change, and end the task with the Docs block from the global CLAUDE.md.
- LF line endings (`.gitattributes`). No em dashes in docs or comments.

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

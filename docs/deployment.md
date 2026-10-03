---
type: Runbook
title: Deploy to the IIS host
description: How to package GitDiagram and run it on SmarterASP.NET with IIS and httpPlatformHandler.
diataxis: how-to
status: draft
sources:
  - id: package-script
    resource: scripts/package-iis.ps1
  - id: web-config
    resource: deploy/iis/web.config
  - id: next-config
    resource: next.config.js
  - id: readiness
    resource: src/server/readiness.ts
  - id: health-route
    resource: src/app/api/healthz/route.ts
  - id: sse-route
    resource: src/app/api/generate/stream/route.ts
  - id: package-json
    resource: package.json
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
verified:
  - { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
tags: [deployment, iis, hosting]
---

# Deploy to the IIS host

This page tells you how to put GitDiagram on the SmarterASP.NET host. The decision record is [ADR 0003](decisions/0003-self-hosted-single-operator.md).
The host has Windows Server 2022 and IIS. `httpPlatformHandler` starts `node server.js` for the site. The app pool has a 1 GB limit.

The host selects the Node.js release. The first deployment used Node.js 25. The `engines` field in `package.json` accepts 24 and 25.

The site is `gitdiagram.tuple.pro`. The file `plans/private-fork.md` holds the probe results behind these values.

## Build machine

You must build the package on Windows x64. The package holds the `ffmpeg.exe` file of the build machine, from `ffmpeg-static`.

1. Install Node.js 24 or 25.
2. Install Bun 1.3.14.
3. Run `bun install` in the repository.
4. Set `NEXT_PUBLIC_VIDEO_EXPLAINER=1` in the shell, if you want videos. Next.js writes this value into browser code at build time.

## Package

Run `bun run package:iis`. The script `scripts/package-iis.ps1` does these tasks in order:

1. It stops if the machine is not Windows x64, or if Node.js is not release 24 or 25.
2. It runs `bun run build`. The `-SkipBuild` parameter uses the `.next/standalone` folder that is there.
3. It copies `public` and `.next/static` into the standalone folder.
4. It copies `deploy/iis/web.config` to `web.config` in the standalone folder.
5. It makes `App_Data/logs/.keep`, so the log folder is in the package.
6. It deletes each `.env*` file in the package, and stops if one stays.
7. It stops if a `src` folder is in the package. `outputFileTracingExcludes` in `next.config.js` keeps sources out.
8. It stops if `server.js` or `node_modules/ffmpeg-static/ffmpeg.exe` is missing.
9. It writes `artifacts/gitdiagram-iis-<date>-<time>.zip`.

The package holds no secret. `next.config.js` sets `output: "standalone"`, so the package has its own `server.js`.

## Upload

1. Stop the app pool before you extract the files. If Node runs during the extract, it can stay alive and keep its port. The next start then fails with `EADDRINUSE`, and IIS answers 502.
2. Extract the zip into the site root. Keep the `App_Data` folder of the host. It holds `gitdiagram.db` and all saved files.
3. Check that `server.js` and `web.config` are in the site root.
4. Set the startup file of the NodeJS Manager to `server.js`.
5. Set the values in the next section.
6. Start the site.
7. Open `web.config` in the site root. Make sure that `<environmentVariables>` has five entries: `PORT`, `NODE_ENV`, `HOSTNAME`, `DATA_DIR`, and `SSE_FLUSH_PAD_BYTES`. The NodeJS Manager can write its own `web.config` over the file. Its file has only `PORT` and `NODE_ENV`.

`getDataDir` in `src/server/storage/db.ts:77` reads `DATA_DIR`. The template sets `DATA_DIR=App_Data`. This path is relative to the site root, because the standalone `server.js` changes its working folder to its own folder.
Only `App_Data` is writable on the host. IIS does not send files from `App_Data`. The probe showed a 404 answer for a file there.

## App pool values

Set each value in the next table in the environment of the IIS app pool. Do not write secrets in `web.config`.

| Key | Rule | Meaning |
| --- | --- | --- |
| `OPERATOR_TOKEN` | Necessary. 40 characters or more. | The operator secret. `operatorToken` in `src/server/auth/operator.ts` signs sessions with it. |
| `CACHE_KEY_SECRET` | Necessary. Do not change it. | `createPatNamespace` derives private storage namespaces from it. A new value makes saved private results unreachable. |
| `AI_PROVIDER` | Necessary. | One of `openai`, `anthropic`, `gemini`, `grok`, `openai-compatible`. |
| `AI_API_KEY` | Necessary. | The key for the selected provider. |
| `AI_MODEL` | Necessary for each provider but `openai`. | The model name. OpenAI uses `gpt-6-luna` if empty. |
| `AI_BASE_URL` | Optional. | A provider endpoint. It is necessary for `openai-compatible`. |
| `GITHUB_PAT` or `GITHUB_PATS` | Optional. | The GitHub token or token pool of the server. |
| `VIDEO_EXPLAINER_ENABLED` | Optional. Set `1` for videos. | Lets the server accept video requests. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | Videos only. | Keys for the video script, design, and voice models. |

Use a long random operator token. The [configuration inventory](configuration.md) lists all keys.

If Node.js does not get the app pool values, put the same values in the `environmentVariables` element of `web.config`. Use this only if the first method does not work.
Do not commit that file.

## What the web.config sets

The file `deploy/iis/web.config` starts from the file that the NodeJS Manager writes. It adds the following values.

- `responseBufferLimit="0"` on the handler. The default holds a response of 4 MB in a buffer.
- `requestTimeout="00:10:00"` on `httpPlatform`. The default of 2 minutes cut long generations.
- A `httpTohttps` rewrite rule. It comes from the HTTPS toggle of the host panel. Keep it, or the redirect stops.
- `PORT` from `%HTTP_PLATFORM_PORT%`. The handler can add spaces after the value. The app removes them.
- `HOSTNAME=127.0.0.1`, so the Node.js server listens on the loopback address only.
- `DATA_DIR=App_Data`, as the section Upload says.
- `SSE_FLUSH_PAD_BYTES=9216`. The host ARR front end buffers a response below about 8 KB. `getSseFlushPadBytes` in `src/app/api/generate/stream/route.ts:101` reads this value and pads each stream batch to this length.
- The log file `.\App_Data\logs\node.log`. If the host refuses this folder, use `.\log.txt`.

The file has no `urlCompression` and no `requestFiltering` section. The host locks them, and they cause HTTP status 500.
The NodeJS Manager can write a new `web.config` when you change its values. Compare the file with `deploy/iis/web.config` after each change.

## TLS and DNS

1. Request the free SSL certificate for the site in the host panel. The host issues a certificate from Lets Encrypt and makes a new one before the end date.
2. In Cloudflare, set the record for `gitdiagram.tuple.pro` to DNS only. Cloudflare then does not proxy the traffic.
3. Set the HTTPS redirect in the host panel. It writes the `httpTohttps` rule.
4. Check that `http://` answers 301 and `https://` shows a valid certificate.

`next.config.js` sends the `Strict-Transport-Security` header. A Cloudflare proxy in Flexible mode sends plain HTTP to the origin. Do not use it.

## Checks

1. Open `/api/healthz` with no session. The answer is `{"ok":true}` with status 200. Status 503 means that a check is not correct.
2. Sign in at `/sign-in` with the operator token. Open `/api/healthz` again. The answer then shows `configuration`, `provider`, `database`, and `dataDir`. `checkReadiness` in `src/server/readiness.ts:73` gives these four checks.
3. Make a diagram for a private repository. Use the GitHub token of the server, or save a caller token in the browser.
4. Look at the progress events. They must come during the run, not at the end. If they come at the end, see the section Troubleshooting.
5. Recycle the app pool. Sign in again and open the saved diagram. The data in `App_Data` must survive.

## Values to keep

- Do not set `VIDEO_RENDER_ENABLED`. `isVideoRenderEnabled` in `src/server/explainer/config.ts:12` then makes the render routes answer 501. The 1 GB pool is too small for Chrome and ffmpeg. Playback in the browser continues to work.
- Videos work for public repositories only.
- Keep `SSE_FLUSH_PAD_BYTES` at 9216.

## After the first deployment

1. If you use a caller API key, enter it again one time in the browser. The app ignores cookies from earlier versions.
2. Delete the probe from the host. It is the `deploy/spike` folder of the repository. Remove its files and its site entry. The probe token was in a chat, so do not use it again.
3. Make sure in the host panel that the certificate has an automatic renewal. The current certificate ends on 2026-12-28.

## Troubleshooting

| Problem | Cause and task |
| --- | --- |
| HTTP status 500 for all pages | A locked section is in `web.config`. Remove `urlCompression` and `requestFiltering`, or restore `deploy/iis/web.config`. |
| A stream stops after about 125 seconds | No data flowed, so the front end closed the connection. Make sure that `SSE_FLUSH_PAD_BYTES` is 9216 in the process. The app sends a padded heartbeat at an interval of 15 seconds. |
| All events come at the end | The front end holds a response below about 8 KB in a buffer. Make sure that `SSE_FLUSH_PAD_BYTES` is 9216. Make sure that `responseBufferLimit="0"` is set. |
| `/api/healthz` answers 503 | Sign in and read the four checks. The check `configuration` must have `DATA_DIR` and `CACHE_KEY_SECRET`. The check `provider` must have correct `AI_*` values. |
| The site does not start | Read `App_Data\logs\node.log`. Look at the Node.js release in the NodeJS Manager. Look at the values in the app pool. |
| Sign-in does not work after a lockout | The global wrong-token counter blocked sign-in. The log has an `auth.sign_in.blocked` event. Wait for the window to end. |
| Sign-in says to wait 15 minutes, but the log has no `auth.sign_in.blocked` event | The app cannot read the counter in SQLite, so it refuses all sign-ins. Usually `DATA_DIR` is missing because the NodeJS Manager replaced `web.config`. Restore `deploy/iis/web.config`, then stop and start the app pool. |
| HTTP status 502, and the log has `EADDRINUSE` | An earlier Node process still holds the port. Stop the app pool, wait 30 seconds, and start it. If the error stays, ask the host support to stop the `node.exe` processes of the app pool. |
| The log shows `0.0.0.0` as the listen address | `HOSTNAME` is missing, so `web.config` is not the template. Restore `deploy/iis/web.config`. |

The log has no secret. `redactLogText` in `src/server/log.ts:84` removes key-like text before the app writes a line.
For local setup, see [Local development setup](dev-setup.md).

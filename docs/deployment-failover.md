---
type: Runbook
title: Host recovery
description: How to put GitDiagram back on the IIS host from a package and a copy of App_Data. The Vercel and Railway paths are removed.
diataxis: how-to
status: draft
sources:
  - id: readiness
    resource: src/server/readiness.ts
  - id: web-config
    resource: deploy/iis/web.config
  - id: package-script
    resource: scripts/package-iis.ps1
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
verified:
  - { by: codex/gpt-6-astra, at: 2026-09-28T19:16:06Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-10-01T12:00:00Z }
---

# Host recovery

This page tells you how to put the app back after a failure. A failure is a bad deployment or site data that is gone. The full deployment steps are in [Deploy to the IIS host](deployment.md).
The fork has no standby host. The Vercel, Railway, and Docker files are removed. Standalone output is always on.

## What holds state

All state is in the `App_Data` folder of the site, which `DATA_DIR` names. It holds `gitdiagram.db`, the folders `objects`, `video`, and `tmp`, and `logs`.
The package holds no state and no secret. The secrets are in the environment of the app pool of the host.

## Go back to a previous package

1. Keep the previous zip from `artifacts/`.
2. Stop the site in the NodeJS Manager.
3. Extract the previous zip into the site root. Do not delete `App_Data`.
4. Compare `web.config` with `deploy/iis/web.config`.
5. Start the site and do the checks in the section Checks of [Deploy to the IIS host](deployment.md).

## Back up and restore the data

1. Stop the site. SQLite in WAL mode keeps more files adjacent to `gitdiagram.db`.
2. Copy all of the `App_Data` folder.
3. To put the data back, stop the site and copy the folder to the site root. Start the site.

Keep the same `CACHE_KEY_SECRET`. A new value makes saved private results unreachable. A deleted database makes the app write a new installation nonce, so operator sessions from before it do not work.

## Check the result

`checkReadiness` in `src/server/readiness.ts:73` gives four checks: `configuration`, `provider`, `database`, and `dataDir`. `GET` in `src/app/api/healthz/route.ts:14` answers `/api/healthz`. A caller without a session gets only `ok`. A caller with a session also gets the checks.

See [Configuration inventory](configuration.md) for the keys and [Local development setup](dev-setup.md) for a local check.

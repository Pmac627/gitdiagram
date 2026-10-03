# Private fork: work tracker

Shared tracker for Claude Code and Codex. **Read this first, update it before you stop.**

- Branch: `feat/private-fork` (from `main` at `df81792`). The Professor commits, pushes and merges; agents do not.
- Workflow per phase: plan, test (unit tests first), implement, review. End each phase with an anchored-docs delta and the Docs block from the Professor's CLAUDE.md.
- Mark a step `[x]` only when its tests pass. Mark `[~]` for in progress, with a note of what is left. Add a line to the handoff log at the bottom every session.

## Goal

A single-operator, self-hosted GitDiagram for the Professor's private repos and client repos. Repo data may leave the host only toward GitHub and the AI provider the operator configures.

Target host: SmarterASP.NET W1050. Windows Server 2022, IIS with httpPlatformHandler (not iisnode) behind a SmarterASP ARR front end, and **a 1 GB app pool maximum** (3 GB on the plan). Node **25.2.1**, chosen by the host. The site is `gitdiagram.tuple.pro`, with DNS at Cloudflare. Production runs on Node, not Bun.

## Decisions

| Topic | Decision |
|---|---|
| Sponsors / ads | Remove |
| PostHog | Remove |
| Presence Worker (Cloudflare) | Remove, with the /admin live feed |
| Storage | SQLite through built-in `node:sqlite`, plus local disk. No Upstash, no R2 |
| Access | Operator login gates every page and API route |
| AI providers | One adapter per provider: OpenAI (Responses), Anthropic (SDK), OpenAI-compatible Chat Completions (Gemini, Grok, Ollama/LM Studio/vLLM) |
| Videos | Keep, public repos only |
| MP4 render | **Disabled for now** (2026-09-29): the 1 GB pool is too small for Chrome plus ffmpeg, so step 31 applies. The probe's Chrome/ffmpeg check is deferred; revisit later |
| Dependencies | Remove `posthog-js`, `@sparticuz/chromium`, `@vercel/functions`. Add none |
| SSE on the host | Padded, batched flushes plus heartbeats (step 24b) |
| TLS to the origin | The gap is accepted for now; see the Hosting gate |

## Hosting gate (TLS)

- Today Cloudflare proxies `gitdiagram.tuple.pro` in SSL mode **"Flexible"**: the Cloudflare-to-host leg is **plain HTTP** (`x-forwarded-proto: http`), and the host has no certificate for the name.
- The Cloudflare Origin CA certificate failed, because SmarterASP requires its own CSR and did not accept the Cloudflare-issued certificate. App-level encryption was rejected: the JS arrives over the same plaintext leg, and cookies and tokens would still be replayable.
- **Plan (the Professor, 2026-09-29):** a free SSL certificate for the subdomain has been requested from SmarterASP. When it is issued, switch to **DNS only** (Cloudflare's SSL mode then no longer applies), or stay proxied with **Full (strict)**.
- **CLEARED 2026-09-29** (verified by Claude): the A record is DNS only, and `gitdiagram.tuple.pro` resolves to `208.98.35.99`. A **Let's Encrypt** (YR2) certificate for `gitdiagram.tuple.pro` is valid until 2026-12-28 and served over TLS 1.3. The site answers with no `cf-ray` and `x-forwarded-proto: https`, and `x-forwarded-for` is one `ip:port` entry (the SmarterASP ARR front end). SmarterASP renews the certificate.
- **HTTPS redirect ON** (the Professor, SmarterASP panel toggle, 2026-09-29; it rewrote `web.config`): `http://` answers **301** to `https://`, keeping the path and query. After the change, 8 KB padding still streams on time and plain SSE is still buffered, so behavior is unchanged. There is still **no HSTS** header, so step 16b adds only HSTS. The panel's `httpTohttps` rewrite rule is now in `deploy/spike/web.config`, the template for `deploy/iis/web.config` (step 32). `<rewrite>` is an allowed section on this host.
- ~~Open:~~ plain `http://` answered 200 with no redirect (fixed by the toggle above). Add an HTTPS redirect (a SmarterASP panel toggle if there is one, otherwise the app's `proxy.ts` on `x-forwarded-proto: http` in production) and HSTS. Tracked as step 16b.
- ~~GATE~~ (kept for history): no client private repos on the host until the origin serves valid TLS. Check with `/headers`: either no `cf-ray` over HTTPS, or `x-forwarded-proto: https`. Development continues meanwhile.

## Codex audit mapping (`docs/security-remediation-2026-09-28.md`)

| Finding | Covered by |
|---|---|
| VULN-001 visitor key can reach OpenRouter | Phase 6 step 26 (the key is tied to its provider) |
| VULN-002 anonymous callers use host quota | Phase 4 (operator login) |
| VULN-003 PostHog URL and replay data | Phase 2 step 7 (PostHog removed) |
| VULN-004 secrets in source excerpts | Phase 6 step 27b (approved 2026-09-29) |
| VULN-005 revoked admin cookie during a Redis outage | Phases 4 and 5 (session generation goes to SQLite; fail closed) |

## Phases

### Phase 0: Prerequisites
- [x] 1. The Codex audit is merged to `main`; `feat/private-fork` is created.
- [x] 2. The dependency removals are approved as part of the plan.

### Phase 1: Hosting probe (fail fast)
- [x] 3. Probe app `deploy/spike/` (`server.js` with no dependencies, a `package.json` with `type: commonjs`, a git-ignored `probe.config.json`, and `web.config`).
- [x] 4. Probe run on SmarterASP (2026-09-29). Results:

| Check | Result |
|---|---|
| (a) Node and `node:sqlite` | **PASS.** Node v25.2.1; `sqliteAvailable: true`. httpPlatformHandler; `PORT` arrives padded with trailing spaces (`"7015      "`), so **trim it** |
| (b) SSE for 300 s | **PASS with padding only.** Plain, `Content-Encoding: identity` and ndjson responses are fully buffered even with `responseBufferLimit="0"`: probably the SmarterASP ARR front end (the `x-forwarded-for` entries carry `ip:port`). With nothing flowing, the connection drops at about 125 s. Padding after each write: 8 KB and more flush every event on time; 4 KB flushes every second event; 1 to 2 KB is held to the end. A padded 300 s stream delivered all 60 events on schedule |
| (c) Data folder and SQLite | **PASS.** Outside the site folder is not writable (EPERM at `www\`); `<site>\App_Data` is writable. The row count survived an app pool restart (1 â†’ 2 â†’ 3). `/App_Data/spike.db` returns **404** |
| (d) ffmpeg and Chrome | **Deferred** (MP4 is disabled for now) |
| `web.config` | The NodeJS Manager writes its own. Our additions that work: `responseBufferLimit="0"` on the handler and `requestTimeout="00:10:00"` on `httpPlatform`. Adding `<urlCompression>` or `<security><requestFiltering>` gives **HTTP 500** (locked sections). The manager may regenerate the file when its settings change |
| Memory | The probe's RSS was 57 MB; the shared machine reported about 1.4 GB free |

- [x] 5. Write `docs/deployment.md` from these results (with the anchored-docs skill), together with step 32. The Professor deletes the probe from the host once a real deployment is ready. The probe token was pasted into chat, so do not reuse it.

### Phase 2: Remove sponsors, PostHog, presence
- [x] 6. Sponsors: delete `src/app/advertise/`, `src/app/out/`, `src/app/api/sponsor/`, `src/lib/sponsor-*.ts`, `src/server/sponsor-{clicks,stats}.ts`, `src/hooks/use-sponsor-*.ts`, `src/components/sponsor-slot.tsx` and `public/sponsors/`. Remove the slots from `main-card.tsx`, `repository-workspace.tsx`, `browse-catalog-results.tsx` and `src/app/page.tsx`.
- [x] 7. PostHog: delete `src/lib/analytics-client.ts`, `src/app/api/analytics-context/` and `watch-analytics.ts` with its call sites. Remove the `/phx9a` rewrites (`next.config.js`), the pageview tracker (`src/app/providers.tsx`) and `phx9a` in `src/proxy.ts`.
- [x] 8. Presence: delete `src/components/live-presence.tsx`, `workers/presence/`, `src/server/admin/live-events.ts` with every `emitLiveEvent` call, `/api/admin/presence-feed`, `presence-protocol.ts`, the CSP connect-src entry, the Worker CI job, and the dashboard's live panels.
- [x] 9. Delete `src/server/admin/claude-credit.ts` and `/api/admin/claude-credit`.
- [x] 9r. **Review of Phase 2** (2026-09-29):
  - Checks: lint and knip exit 0; tsc exit 0; tests 1106 passing, with only the baseline environment failures; the isolation and CSP tests pass.
  - Ripwire 0.6.0 `at=df8179285+dirty`: drift=0 on every touched doc under `docs/`. The only drift is in this plan (symbols not built yet, expected); "dated" appears only in the two audit docs. STE: 0 mechanical, warn(61 heuristic). No links to deleted docs remain.
  - **One finding, fixed:** Phase 2 had removed "sponsors" and "a sponsor" from the README-picture rules in `src/server/explainer/shot-prompt.ts`, only to satisfy the isolation scan. That loosened the video model's instruction not to show sponsor pictures from third-party READMEs. Restored from `HEAD`, and `shot-prompt.ts` was added to the `fork-isolation.test.ts` allowlist with the reason.
  - The host findings need no Phase 2 changes. They amend steps 15, 17, 24b, 31 and 32.

### Phase 3: Strip public-service machinery

Scope decisions (Claude, 2026-09-29, from reading the importers; these follow the approved plan):
- **Diagram admission:** the stream and cost routes lose the complimentary gate (`complimentary-gate.ts`, `quota-store.ts`), the per-IP limiter and the infrastructure limiter (`rate-limit.ts`, via `request-admission.ts`), and `refundGenerationRateLimit` in `stream-finalization.ts`. `request-admission.ts` keeps same-origin and credential handling only. `graph-planner.ts` drops `buildComplimentaryStageTokenEstimate` if it only fed the gate. The cost route still returns the estimate. `scripts/complimentary-quota-today.mjs` and the `quota:today` script go too.
- **Video admission:** remove `audience.ts`, `priority-places.ts`, `limited-countries.ts`, `vercel-geo.ts` and the visitor cookie (`visitor.ts`). Also remove the per-person, per-network and daily budgets, the premium quota, the attempt limiter and the render budgets in `limits.ts`. **Keep:** the paid-run concurrency cap (`tryPaidVideoRun`, `VIDEO_MAX_PAID_RUNS`), the per-repo lock, the voice pause, the `paused` control, and `isVideoAdmin` / `isTrustedVideoCaller` (Phase 4 replaces them). `planner.ts` drops the priority-visitor premium path and keeps the star and operator rules.
- **Admin dashboard:** remove the audience and limited-country controls, the budget tiles for the removed budgets, and the complimentary-token tile. Delete `/api/admin/reset` if no counter is left to reset.
- **Vercel:** delete `vercel.json`, `railway.json`, `Dockerfile` and the CI `docker build` job. Remove `@vercel/functions` and `purgeVideoResponse` (`explainer/cache.ts`, the call in `store.ts`), the `Vercel-Cache-Tag`, `Vercel-CDN-Cache-Control` and `CDN-Cache-Control` headers, and the `x-deployment-id` / `dpl` pinning in `render-origin.ts` and `segments.ts`. Keep `/api/internal/browse-index/drain` until Phase 5, although no cron calls it anymore; the browse index then updates only when that route is called by hand. Leave `check:video-tracing` for step 32.
- `.env.example` loses every variable these removals leave unused, and `fork-isolation.test.ts` gains patterns for them.
- **Test-writer open points, decided (Claude, 2026-09-29):**
  - Paid video failures are always `retryable: true` (no daily budget remains).
  - Audit fields `quotaStatus`, `actualCommittedTokens` and `quota_committed_tokens` are removed (`stream-finalization.ts` and the types). Stored artifacts that still contain them must still parse.
  - `videoResponseTag` is removed with `purgeVideoResponse`.
  - `anyDevice` and the `VIDEO_PREVIEW_PAUSED` values `audience` and `device` are removed; `limit` stays, because the voice pause uses it.
  - `process.env.VERCEL` (`render-origin.ts`, `render.ts`) waits for Phase 7, and `VERCEL_GIT_COMMIT_SHA` / `VERCEL_REGION` in `admin/state.ts` wait for Phase 8.
  - Phase 3 deletes the Vercel-specific cache headers; Phase 4 step 14 turns `Cache-Control: public` into `private`. They do not conflict.
- Test-writer result: 8 test files deleted, 21 changed, 112 failing for removed-feature reasons (full run: 956 passing).
- **Implementer result (2026-09-29): Phase 3 and step 16 done.**
  - Deleted: the modules above, plus `.dockerignore`, `admin/confirm-dialog.tsx`, `src/app/sitemap.ts` and `src/lib/sitemaps.ts` (with its test). Removed `@vercel/functions` (lockfile written with `bunx bun@1.3.14 install`).
  - Results: lint and format:check exit 0. tsc and knip were red only on the unfinished Phase 5 tests. The full run had 1057 passing; the failures were only the baseline and the Phase 5 set.
  - One test was wrong, fixed by Claude: the stream test "allows a large repository on the server key…" never arranged the saved-cookie credentials. `mockResolvedValueOnce` was added; it now passes.
- **Leftovers:**
  - (a) Legacy audit fields (`quotaStatus`, `quotaBucket`, `quotaDateUtc`, `actualCommittedTokens`, `quotaResetAt`) remain as optional, never-written fields on `GenerationSessionAudit`. `artifact-store.ts` and `session-audit.ts` copy them. Remove them after Phase 5 "Now" lands (Phase 5 owns `artifact-store.ts`), keeping old artifacts parseable.
  - (b) `includeGraphRepairInputTokens` in `cost-estimate.ts` is no longer set by production code. Remove it with (a).
  - (c) `VERCEL_*` reads (Phases 7 and 8) and `check:video-tracing` (step 32).
  - (d) **The docs pass for Phases 3 and 5 runs as one pass after the Phase 5 "Now" implementer.** The same docs change in both.

- [x] 10. Delete `generate/complimentary-gate.ts`, `generate/rate-limit.ts`, `storage/quota-store.ts`, `explainer/audience.ts`, `features/admin/{priority-places,limited-countries}.ts` and `http/vercel-geo.ts`. (`gate-notice.ts` is already gone in Phase 2.)
- [x] 11. Reduce `explainer/limits.ts` to a concurrency cap. Remove `explainer/visitor.ts` (the cookie).
- [x] 12. Remove `vercel.json`, `railway.json`, `Dockerfile`, `@vercel/functions`, and `x-deployment-id` / `?dpl=` pinning (`segments.ts`, `render-origin.ts`).

### Phase 4: Operator login for everything

Design (Claude, 2026-09-29, from reading `operator.ts`, `sign-in-guard.ts`, `proxy.ts` and the Next 16 proxy docs):
- **Gate in `src/proxy.ts`.** Next 16 runs Proxy on the **Node.js runtime** (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, "Runtime"), so it can fully verify the session: the HMAC signature, the expiry, and the session generation in SQLite.
  - The matcher widens to every path except `_next/static`, `_next/image`, `favicon.ico`, `/video-engine/*` (static stage assets the renderer loads without a cookie; no private data), `/sign-in` and `/api/auth/*`.
  - `/api/video/render/segment` is exempt from the session check but keeps its own HMAC job signature.
  - Without a valid session, pages get a 307 to `/sign-in?next=<same-origin relative path>` and `/api/*` gets a 401 JSON.
  - `next` must be validated: a relative path only; no `//`, no scheme, no backslash.
- **Defense in depth:** a `requireOperator(request)` helper, called by every sensitive route handler (the generate, credentials, video, admin and diagram-state routes), so a matcher mistake cannot open them.
- **Auth module:** `src/server/admin/operator.ts` becomes `src/server/auth/operator.ts`.
  - The token comes from `OPERATOR_TOKEN`, with a `VIDEO_ADMIN_TOKEN` fallback for one release (40+ chars, as now).
  - The session generation moves to SQLite `kv` (durable) and **fails closed** when unreadable (VULN-005).
  - Every signed-in browser is the operator: `isVideoAdmin` and `isTrustedVideoCaller` resolve to the same check.
  - A Bearer token works for scripts (the throttle applies).
- **Sign-in guard:** a **global** wrong-token counter in SQLite, so a forged IP cannot get around it (step 15), with an optional per-network layer. The unused `announce` field goes. After this, `upstash.ts`, its test, `sign-in-guard.redis.test.ts` and the `UPSTASH_*` variables are deleted, with a fork-isolation check.
- **UI:** a `/sign-in` page (a token field and an error message, noindex) and a sign-out action. `/admin` keeps the dashboard only, and its own sign-in form goes.
- **Test-writer result (2026-09-29): steps 13 to 15 tests are written, and the implementer has NOT started.**
  - Choices: the guard lives at `src/server/auth/sign-in-guard.ts` and `requireOperator` at `src/server/auth/require-operator.ts` (no import cycle). The session API is `/api/auth/session` (GET, POST, DELETE, `?everywhere=1`). The matcher is one negative lookahead. `src/lib/safe-next-path.ts`, `src/app/sign-in/{page,sign-in-form}.tsx`, and the helper `src/server/auth/test-session.ts`.
  - Deleted tests: `admin/operator.test.ts`, `sign-in-guard.redis.test.ts`, `upstash.test.ts`, `api/admin/session/route.test.ts`. The implementer deletes their sources and `admin-sign-in.tsx`.
  - Full run: 1088 passing, 15 failing and 27 files that fail to load, all on missing implementation (plus the voice baseline).
  - **Decided (the Professor, 2026-09-30):**
    - (2) **Remove Bearer access.** Cookie sessions only; `proxy.ts` and `requireOperator` accept no `Authorization: Bearer`, and `verifyOperatorBearer` goes.
    - (3) **Exempt `/api/healthz` with a minimal answer:** anonymous callers get `{ok}` with 200/503 only; signed-in callers also get `checks`.
    - (4) **Keep the global wrong-token throttle.** Existing 30-day sessions keep working through a lockout. Log each block (a Warning `auth.sign_in.blocked`, with no token and no IP) so a lockout attack is visible.
    - (1) **Drop the pause switch, keep the safeguards:**
      - Remove `videosPaused` (the control, the `/admin` switch and the `controls` table use).
      - The automatic **voice-credit check applies to the operator too**, so no script is paid for that cannot be voiced.
      - Replacing an existing video needs an **explicit regenerate** action (a request flag plus UI confirmation); without it, `/api/video/generate` answers 409 `exists` as before.
- **Step 26 accepted (2026-09-30):**
  - The API-key cookie is `{version:1, key, provider, baseUrl?}`; legacy cookies are ignored; the dialog is provider-aware. 36 new tests pass, and 256/256 across the credential suites.
  - The agent edited `request-credentials.test.ts` with a node script against its brief. Claude reviewed the diff: it only adds the provider argument and the new fields and weakens nothing, so it is accepted.
  - It also ran a repo-wide `format:write` while another agent was editing. It reported 2 failing `openai.test.ts` service-tier tests; investigate after 27b lands.
- **Step 27b accepted (2026-09-30):**
  - New `secret-scan.ts` (65/65; a 48k excerpt scans in 7 ms, adversarial inputs in 0 to 6 ms); source and README redaction; `redactedSecretCount` in the audit and in the `generate.stream.finished` log. Docs: drift=0, 0 mechanical STE.
  - Minor: the stream route sets the count with an object spread instead of `withRedactedSecrets`, so the helper's validation is not used in production. Tidy it with step 27.
- **Investigated the 2 `openai.test.ts` failures (Claude, 2026-09-30):**
  - Codex deliberately made `getGenerationServiceTier` return `default` (standard billing).
  - `src/server/generate/openai.ts` is **dead code** left behind by the step 22 move to `ai/openai-responses.ts`: only `openai.test.ts` imports it (grep), and knip flags it. The failing tests assert the old "Fast" behavior of that dead module.
- **Decision 1 test-writer (2026-09-30):** the tests are written. `controls.ts` and `/api/admin/controls` are to be removed; the `controls` table stays unused (migrations are append-only); `ControlsPanel` takes no props. Generate route order: exists (409 unless `regenerate: true`) → voice check for everyone → lock. "Try again" after a failed regeneration keeps the flag without asking again. It rewrote `api/admin/routes.test.ts` with a heredoc; Claude reviewed it (only the removed controls-route cases were dropped; the state 401/200 remain). A stray `git rm --cached /dev/null` changed nothing (index verified clean).
- **Decisions 1–4 implemented and verified (Claude, 2026-09-30):**
  - Bearer is gone; the healthz answer is minimal; `auth.sign_in.blocked` logs once per window (a flag in `kv`); the pause switch and `controls.ts` / `/api/admin/controls` are removed; the voice check applies to everyone; explicit `regenerate`; the stream route uses `withRedactedSecrets`.
  - Results: nothing staged; lint, tsc and format:check exit 0; 1675/1678 tests (the voice `/bin/sh` baseline and the 2 dead-code `openai.test.ts`).
  - Claude fixed the last mechanical STE failure in `docs/configuration.md` ("switch" → names `VIDEO_RENDER_ENABLED`). Ripwire: drift only in this plan (not-yet-built names).
  - knip leftovers: the dead `openai.ts` (pending), plus unused exports `TEST_OPERATOR_TOKEN` (`auth/test-session.ts`), `assertLiveStorageAllowedForTests` (`storage/config.ts`) and `TextVerbosity` (`ai/provider.ts`). Clean them up with step 27.
  - **Phase 4 is complete.** Next: step 27 (its test-writer is running).
- **Step 27 test-writer (2026-09-30):**
  - Contract: `redactLogText(text, knownSecrets?, max=500)` in `log.ts` (the secret-scan patterns, exact known and env secrets, partially masked suffixes, Bearer and Authorization values; redact before truncating), and `errorText` redacts too.
  - A source check (`log-redaction.test.ts`) found 17 log sites that carry upstream text.
  - It used `sed` and a heredoc on `github-auth.test.ts`; reviewed, additions only.
  - **Claude corrected an existing test** (`github.test.ts`, "keeps the GitHub error body out of the thrown message"): it asserted that a GitHub token *stays* in the server log. It now asserts that the diagnosis stays and a realistic `ghs_` token does not (it fails today, as it should).
  - **Step 27 implemented and verified (Claude, 2026-09-30):** `redactLogText` is wired into 17 log sites; `errorText` redacts. The knip leftovers are fixed (two unexported, `assertLiveStorageAllowedForTests` deleted). Claude ran Prettier on three test files (formatting only), found and fixed a bug in `github.ts` `outgoingCredential` (`split(/s+/)` split on the letter "s"; now `/\s+/`), and added the test that exposed it ("scrubs the exact outgoing credential when GitHub echoes it back"). Gate: format, lint and tsc exit 0; 1704/1707 tests (the voice baseline and the 2 dead-code openai tests); knip flags only the dead `openai.ts`. **Phase 6 is complete.**
  - **Resolved (the Professor, 2026-10-01):** `generate/openai.ts` and its test are deleted, with the two stale `vi.mock("~/server/generate/openai")` blocks in `cost-estimate.test.ts` and `stream/route.test.ts`. `import "server-only"` is restored in `log.ts`; the server Vitest project now stubs `server-only` once in `vitest.server-setup.ts`. The stale knip `ignoreBinaries: ["redis-server"]` is removed. Gate: format, lint, tsc and knip exit 0; 1692/1693 tests (only the voice `/bin/sh` baseline, step 29).
  - **Originally DECISION NEEDED (the Professor):**
    1. Should the `videosPaused` switch still block the operator? Today trusted callers skip the pause, voice and "exists" checks, so once everyone is the operator the switch does nothing. The test-writer encoded "operator skips". Flip the tests if the pause should apply.
    2. A Bearer token passes `/api/*` through the proxy, for scripts (tested; not in the original design). Accept it?
    3. `/api/healthz` is gated (401 unsigned). Should uptime checks be exempt?
  - **Implementer to-dos:** `explainer-video.tsx` still fetches `/api/admin/session`. Check that a Node-runtime Proxy importing `node:sqlite` bundles correctly (`serverExternalPackages`?). Every temp `DATA_DIR` starts at generation 0, so minted test cookies stay valid across tests (hazard).
- **Cache-Control:** gated responses are never `public` or `s-maxage`. Convert the remaining ones (`/api/video/*`, `diagram-preview`, `browse-index`, `og/cards.tsx`) to `private`, and keep `immutable` where the URL is versioned.

- [x] 13. Turn `src/server/admin/operator.ts` into `src/server/auth/operator.ts`. The env var is `OPERATOR_TOKEN`, with a `VIDEO_ADMIN_TOKEN` fallback for one release.
- [x] 14. Gate in `src/proxy.ts`: without a session, pages redirect to `/sign-in` and `/api/*` gets a 401. Exempt `/sign-in`, `/api/auth/*`, `_next/static` and the `video-engine` assets. The segment route stays HMAC-signed. **Host finding:** Cloudflare may sit in front, so every gated response must be `Cache-Control: private` (or `no-store`), never `public` or `s-maxage`. Convert the remaining `public` headers (`/api/video/*`, `diagram-preview`, `browse-index`, `og/cards.tsx`).
- [x] 15. Move `sign-in-guard.ts` and the session generation to SQLite, and fail closed. **Host finding:** the origin is also reachable directly over HTTP (`208.98.35.99`), so `x-forwarded-for` and `cf-connecting-ip` can be forged. For a single operator, throttle wrong tokens with a **global** counter (with an optional per-IP layer), so a forged IP cannot get around it.
- [x] 16. `robots.ts` disallows all, the sitemap is off, and the root layout gets `noindex`.
- [x] 16b. (Already satisfied: the panel sends the 301, and `next.config.js` already sends HSTS; `next-config-hsts.test.ts` guards it.) HTTPS only: in production, `proxy.ts` sends a 308 to `https://` when `x-forwarded-proto` is `http`, and responses carry `Strict-Transport-Security: max-age=31536000`. Skip this if a SmarterASP panel toggle already forces HTTPS, but keep HSTS. Unit test both.

### Phase 5: SQLite and local disk

Split (Claude, 2026-09-29), so Phase 5 can run while Phase 3 finishes:
- **Now:** 17 (`db.ts`), 18a (`distributed-lock.ts`, `generate/cancellation.ts`, `status-store.ts`, `video-index.ts`, and deleting `browse-index-pending.ts` in favor of update-on-write), 19 (object store) and 21 (readiness).
- **After Phase 3 lands:** 18b (`explainer/limits.ts` paid-run counter and repo lock, `admin/controls.ts`, the `voice.ts` pause key) and 20 (`explainer/store.ts`, `explainer/cache.ts`). `operator.ts` and `sign-in-guard.ts` move in Phase 4 (step 15).
- **Decision (the Professor, 2026-09-29): artifacts are files on disk,** not SQLite rows. Design:
  - Each object lives at `DATA_DIR/objects/<bucket>/<key path>`.
  - The etag is a content hash (sha256 of the stored bytes).
  - A conditional write (`ifMatch` / `ifNoneMatch`) runs its check-then-write inside a SQLite `BEGIN IMMEDIATE` transaction, the cross-process lock for IIS overlapped recycles, and ends with a temp file plus an atomic rename.
  - Keys are validated: no `..`, no absolute paths, no drive letters, no NUL; they must stay under the root.
  - Windows is case-insensitive, while R2 was not. Check whether keys are already lowercased, and flag any collision risk.
- **Test-writer result (2026-09-29):** the `db.ts` API is documented in the `db.test.ts` header. The shared helper `storage/test-data-dir.ts` provides `createTempDataDir()`. Suites fail on the missing `db` / `object-store` modules, as expected.
- **Decisions on its points (Claude, 2026-09-29):**
  - **Uppercase keys and buckets are rejected**: every app-built key is already lowercase (`cache-key.ts` `normalizeSegment`, hex digests, lowercase constants). Follow-up in this phase: lowercase the `%XX` output of `encodeURIComponent` in `normalizeSegment`.
  - **Windows device-name segments are rejected** (`con`, `aux`, `nul`…). Known limitation: a repo with such a name is not cached; the persistence error is logged and generation still works.
  - **Browse index updates on write** (`upsertBrowseIndexEntry` under `lock:v1:public-browse-index`, and it creates the index when none exists). `browse-index-pending.ts`, `drainPendingBrowseIndex`, `/api/internal/browse-index/drain` and `CRON_SECRET` are removed now; this replaces the "keep until Phase 5" note in Phase 3.
  - **`cache-key.ts`**: fixed bucket names `public` and `private` replace `R2_PUBLIC_BUCKET` / `R2_PRIVATE_BUCKET`.
  - `explainer/catalog.test.ts` mocks Upstash around `indexVideo`. The Phase 5 implementer fixes it (temp `DATA_DIR`).
  - The "gallery index" block in `video-state.redis.test.ts` duplicates `video-index.test.ts`; remove it in 18b.
  - `r2.ts`, `upstash.ts` and their tests stay until 18b and 20 no longer use them.
- **"Now" implementer result (2026-09-29): steps 17, 18a, 19 and 21 done.**
  - New `db.ts` (WAL, `busy_timeout` 5000, `synchronous NORMAL`, `user_version` migrations, `SCHEMA_VERSION` 1), `object-store.ts` (temp files in `DATA_DIR/tmp`, rename retried on EPERM/EBUSY) and `kv.ts`.
  - Schema: `locks(key, token, expires_at)`, `kv(key, value, expires_at)`, `video_index(repo_key, created_at, card)`.
  - The drain route and `browse-index-pending.ts` are deleted.
  - Deviation: the bucket names default to `public` / `private`, but `R2_PUBLIC_BUCKET` / `R2_PRIVATE_BUCKET` still override them (two fs tests set them). Remove the overrides with step 20.
  - Verified by Claude: nothing staged. The agent's stray `git rm --cached` on one path was undone by the agent and confirmed clean. lint, knip, tsc and format:check all exit 0. The full run: 1209 passing, 7 failing (5 baseline, plus `generate/cancel/route.test.ts` ×2 and `limits.test.ts` ×2, which still mock Upstash; fixed in 18b).
- **Next tranche ("After", now unblocked):**
  - 18b: `limits.ts` paid-run counter and repo lock, `admin/controls.ts`, the `voice.ts` pause key; fix the cancel-route and limits tests; delete `video-state.redis.test.ts`.
  - 20: `explainer/store.ts` local only, the Windows key fix, and MP4 streaming instead of presign, then remove the `R2_*` overrides and `r2.ts` with its S3 SDK dependencies.
  - Phase 3 leftovers (a) and (b).
  - `upstash.ts` stays until Phase 4 moves `operator.ts` and `sign-in-guard.ts`.
  - Docs for Phases 3 and 5 run once, after this tranche.
- **"After" test-writer result (2026-09-29):**
  - The tests cover the ports of limits, controls and the voice pause to SQLite.
  - store.ts is local only, with `/` keys and path-traversal rejection.
  - The MP4 file route streams, with Range support: 206 for a single range, 416 with `bytes */size`, multi or malformed ranges ignored (200), and `Accept-Ranges` always sent.
  - fork-isolation: upstash is imported only by `operator.ts` and `sign-in-guard.ts`; no r2, `@aws-sdk` or `R2_*`/`VIDEO_STORE`; no legacy audit fields.
  - Deleted: `video-state.redis.test.ts`, `r2.test.ts`, `explainer/test-redis.ts`.
  - Claude added: video generation refuses Windows device-name owners or repos **before any paid work** (400), reusing the object-store validator.
  - **"After" implementer result (2026-09-29): steps 18b and 20 plus leftovers (a) and (b) done.** New `fs-safety.ts` (the shared name rules and `renameWithRetry`). Migration 2 (`SCHEMA_VERSION` 2) adds `paid_runs` and `controls`. `store.ts` is local only; MP4s stream with Range support; `r2.ts` and the `@aws-sdk/*` packages are removed; the bucket names are fixed. Verified by Claude: nothing staged, lint, knip, tsc and format:check exit 0, 1259 tests pass, and the only failures are the voice `/bin/sh` baseline and `sign-in-guard.redis.test.ts` (Phase 4). The agent corrected three test bugs: the prune sort order ×2 and an invalid picture id `img9` → `img3`. **Phase 5 is complete.** Only `operator.ts` and `sign-in-guard.ts` still import `upstash.ts`.

- [x] 17. `src/server/storage/db.ts`: a `node:sqlite` `DatabaseSync` at `DATA_DIR/gitdiagram.db`, WAL mode, versioned idempotent migrations. `DATA_DIR` is required. **Host finding:** only `<site>\App_Data` is writable there. IIS does not serve `App_Data` (verified: 404), so that is the production `DATA_DIR`. Locally, any folder outside the repo works.
- [x] 18. Replace the `upstash.ts` consumers behind unchanged signatures: `distributed-lock.ts` (a row lock with expiry), `cancellation.ts`, `status-store.ts`, `generation-persistence.ts`, `video-index.ts`, `explainer/cache.ts`, `admin/controls.ts`, and the `voice.ts` pause key. Delete `upstash.ts` and `browse-index-pending.ts`, and update the browse index on write.
- [x] 19. `r2.ts` becomes `storage/object-store.ts` (fs under `DATA_DIR/objects`, same interface). Keep the HMAC(PAT) private namespace.
- [x] 20. `explainer/store.ts` runs local only (`DATA_DIR/video`). Fix the Windows `path.join` key bug (see the baseline). MP4 downloads stream through `/api/video/file`.
- [x] 21. `readiness.ts` and `/api/healthz` check the DB and `DATA_DIR`.

### Phase 6: Provider adapter layer
- [x] 22. `src/server/ai/provider.ts` (`streamText`, `parseStructured(zod)`, optional `countInputTokens`), with the adapters `openai-responses.ts` (moved from `generate/openai.ts`), `anthropic.ts` (a forced tool call) and `openai-chat.ts` (`json_schema`, falling back to validate and retry).
- [x] 23. `model-config.ts`: `AI_PROVIDER` = openai | anthropic | gemini | grok | openai-compatible, plus `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY`. Add the Gemini and Grok presets and remove the hardcoded OpenRouter URL.
- [x] 24. Point `graph-planner.ts`, the stream and cost routes and `generation-policy.ts` at the interface.
- [x] 24b. **SSE flusher for the host** (from probe (b)):
  - The stream route's writes go through a flusher that batches events for at most ~250 ms.
  - Each batch is followed by an SSE comment that pads it to at least `SSE_FLUSH_PAD_BYTES` (9216 on the host, 0 locally, which means no padding).
  - A padded heartbeat comment goes out every 15 s while idle (Cloudflare drops connections idle for ~100 s, ARR for ~120 s).
  - The client SSE parser must ignore comment lines. Check `src/features/diagram` SSE parsing and add a test.
  - Unit tests: batching, padding size, the heartbeat timer (fake timers), and no padding when the setting is 0.
- [x] 25. `pricing.ts`: an unknown or local model gives a `null` cost (the UI shows "n/a"). Token counts fall back to a character estimate.
- [x] 26. `request-credentials.ts`: the BYOK cookie is tied to its provider (VULN-001).
- [x] 27. Scrub key-like patterns from `raw_error` (`generate/stream/route.ts`) and `generate/cost/route.ts` logs.
- [x] 27b. **Approved (2026-09-29):** a content secret scan before source excerpts enter prompts (VULN-004, Choice B). Redact or drop matches (key and token patterns, private key blocks, high-entropy assignments) and note the count in the run log. Add tests with secrets in ordinary source files.

### Phase 7: Videos on the Windows host (public repos only)
- **Done (Claude, 2026-10-01):** test-writer then implementer (Sonnet), reviewed by Claude. `@sparticuz/chromium` is removed (package, lock, `next.config.js`, `render.ts`, tracing script; ffmpeg tracing is `ffmpeg-static/ffmpeg*` for `ffmpeg.exe`). `isVideoRenderEnabled()` gates the render and segment routes (501), the generate route skips the poster, `GET /api/video` sends `renderEnabled`, and `ExplainerShare` hides the MP4 and README picture actions unless it is true. The voice test is portable. Gate: 1727/1727 tests; tsc, lint, format:check, knip exit 0. Docs delta done. Open for step 32: the 95 MB segment-route ceiling in `scripts/check-video-render-tracing.mjs` is now loose (no bundled Chromium); `next build` and `check:video-tracing` were not run yet. Delete the stale `tsconfig.tsbuildinfo` if tsc reports phantom errors.
- [x] 28. Keep `director.ts` and `voice.ts` as they are; leave a TODO seam for `src/server/ai/`.
- [x] 29. `render.ts`: drop `@sparticuz/chromium` and require `VIDEO_RENDER_CHROME_PATH` (for local renders). Make the fake ffmpeg in `voice.test.ts` portable (see the baseline).
- [x] 30. `render-origin.ts`: use `http://127.0.0.1:${PORT}` (trimmed), with `VIDEO_SEGMENT_CONCURRENCY=1` as the default.
- [x] 31. **Required** (MP4 is disabled): the render routes return 501 unless `VIDEO_RENDER_ENABLED=1`, and the UI hides the MP4 download and share options when rendering is off. In-browser playback stays.

### Phase 8: Packaging, rebrand, docs
- **Decisions (the Professor, 2026-10-01):**
  - Name: keep "GitDiagram"; the footer and README credit the upstream `ahmedkhaleel2004/gitdiagram` (MIT; keep `LICENSE` as is). `SITE_URL` becomes `https://gitdiagram.tuple.pro`.
  - Secrets (`OPERATOR_TOKEN`, `AI_API_KEY`, GitHub token, `CACHE_KEY_SECRET`): set as IIS application pool environment variables first; fall back to `web.config` `environmentVariables` if the child Node process does not inherit them. The repo template holds no secrets, only non-secret values (`PORT`, `NODE_ENV`, `HOSTNAME=127.0.0.1`, `DATA_DIR=App_Data`, `SSE_FLUSH_PAD_BYTES=9216`). `DATA_DIR` may be relative: standalone `server.js` runs `process.chdir(__dirname)` and `getDataDir` resolves at call time.
  - Remove the star reminder (`useStarReminder`) and the GitHub star-count fetch in the root layout.
  - httpPlatformHandler stdout log: `.\App_Data\logs\node.log` (the package ships `App_Data/logs/.keep` so the folder exists). Fall back to the root `log.txt` if the host refuses.
  - The package must contain no `.env*` file (standalone output can copy them).
- **Steps 32 and 33 done (Claude, 2026-10-01):** test-writer then implementer (Sonnet) for each, run in parallel, reviewed by Claude.
  - Step 32: `output: "standalone"` always; `engines.node` `>=24 <26`; `deploy/iis/web.config` (no secrets; `HOSTNAME=127.0.0.1`, `DATA_DIR=App_Data`, `SSE_FLUSH_PAD_BYTES=9216`, log in `App_Data\logs\node.log`); `scripts/package-iis.ps1` (`bun run package:iis`, zip in `artifacts/`, strips `.env*`, refuses `src/`); segment tracing ceiling 12 MB (measured 5.1 MB); dead `/advertise` perf budget removed. Claude found that the video routes traced all of `src/server/explainer` (tests included) into standalone output and added `outputFileTracingExcludes: { "/**": ["./src/**"] }`, plus removed the dead `transpilePackages: ["@aws-sdk/client-s3"]` (tests first). Local smoke test: `/api/healthz` 503 `{ok:false}` with no secrets (expected).
  - Step 33: `SITE_URL` is `https://gitdiagram.tuple.pro`; footer has one upstream credit link; star reminder, header star count and `github-stars.ts` removed; upstream author metadata removed; `.env.example` adds `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `SSE_FLUSH_PAD_BYTES` and drops four dead keys; `README.md` rewritten. `opengraph-image.png` (and the identical `twitter-image.png`) has no upstream branding but says "replace 'hub' with 'diagram'"; left as is.
  - Gate: 1773/1773 tests; tsc, lint, format:check, knip, `check-video-render-tracing`, `check-performance-budgets` exit 0. Package: `artifacts/gitdiagram-iis-20261001-1022.zip` (39.6 MB).
  - App pool secrets list (for `docs/deployment.md`): required `OPERATOR_TOKEN` (>= 40 chars), `CACHE_KEY_SECRET` (never rotate), `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` (optional only for openai); optional `AI_BASE_URL`, `GITHUB_PAT`/`GITHUB_PATS`; videos: `VIDEO_EXPLAINER_ENABLED=1`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `NEXT_PUBLIC_VIDEO_EXPLAINER=1` on the BUILD machine (inlined at build).
- [x] 32. Packaging for the host:
  - `next.config.js` `output: "standalone"`. The standalone `server.js` is the NodeJS Manager's startup file at the site root.
  - `deploy/iis/web.config`: copy `deploy/spike/web.config`. It is the manager's file plus `responseBufferLimit="0"`, `requestTimeout="00:10:00"` and the panel's `httpTohttps` rewrite rule. **No** `urlCompression` or `requestFiltering` (HTTP 500 on this host).
  - Trim `PORT`, and check that the standalone server does.
  - `DATA_DIR=<site>\App_Data`.
  - `scripts/package-iis.ps1` builds, copies `public` and `.next/static` into the standalone folder, and zips it.
  - `package.json` `engines.node` must allow 24 (local) and 25 (host).
- [x] 33. Rebrand: the footer, metadata, OG images, `README.md`, `.env.example` (add `DATA_DIR`, `OPERATOR_TOKEN`, `AI_*`, `SSE_FLUSH_PAD_BYTES`), and the star reminder.
- [x] 34. Rewrite the project `CLAUDE.md`. Run an anchored-docs delta across `docs/`, and add an ADR in `docs/decisions/` (self-hosted, single operator, SQLite, provider adapters, the host constraints).

## Backlog (after Phase 8)

Open items found during the first host deploy (2026-10-01). Each follows plan, test-writer, implementer, review, docs. Tick here when done.

- [ ] B1. **GitHub PAT expiry sets the cookie lifetime** (approved by the Professor, 2026-10-01).
  - In `setCredential` (`src/server/http/request-credentials.ts`), saving a `github_pat` first calls `GET https://api.github.com/rate_limit` with that token (no rate-limit cost; GitHub is already allowed egress), with a 3 s deadline.
  - Read the `GitHub-Authentication-Token-Expiration` header. Cookie `maxAge` = min(30 days, seconds until expiry). No header (token never expires) or a later expiry gives 30 days. Never longer than 30 days.
  - A 401 blocks the save with "This token is invalid or expired." (approved). An expiry already in the past is treated the same way.
  - GitHub unreachable, slow or a malformed header: save for 30 days as today and log one warning (no token in the log).
  - Show the expiry in the credential dialog (approved): a separate non-secret cookie holds only the expiry date; `getCredentialStatus` returns it; `src/components/credential-dialog.tsx` shows "GitHub access expires <date>".
  - Tests: 7-day, 90-day and no-expiry tokens, past expiry, 401, timeout, malformed header; the token never appears in logs or the status response.
  - Docs: `docs/configuration.md`, `docs/flows/diagram-generation.md`.
- [ ] B2. **Private repos with the server `GITHUB_PAT`** (DECISION NEEDED, the Professor). Today a private repo needs a PAT entered in the browser (`src/server/generate/github.ts:580`, `source-context.ts:156`); the private storage namespace is derived from that browser PAT (`cache-key.ts:29`). Options: A keep as is (current); B fall back to the server PAT (namespace from the server PAT; rotating it orphans private diagrams); C fall back to the server PAT and derive the private namespace from `CACHE_KEY_SECRET` alone (recommended if the browser step is unwanted). `docs/deployment.md` must not imply that `GITHUB_PAT` alone covers private repos; check its wording.
- [ ] B3. Remove the upstream "solo student engineer" quota message in `src/server/generate/errors.ts` (`DEFAULT_OPENAI_KEY_QUOTA_EXHAUSTED_ERROR`) and extend `src/server/rebrand-guard.test.ts` to catch it.
- [ ] B4. A graph-step failure is recorded with failure stage `explanation` (seen with the Gemini 400). Advance the audit stage before `generateValidatedGraph` in `src/app/api/generate/stream/route.ts`.
- [ ] B6. **Log why sign-in fails closed.** The `catch` in `checkSignIn` (`src/server/auth/sign-in-guard.ts`) returns `blocked: true` with no log, so a storage failure (for example a missing `DATA_DIR`) looks like a 15-minute lockout. Log `auth.sign_in.guard_failed` at error level with `errorText(error)` (no token), and consider a distinct answer such as "Sign-in is unavailable right now" instead of the lockout message. Seen on the host 2026-10-01 after the NodeJS Manager overwrote `web.config`.
- [ ] B9. **Browse becomes the operator's own catalog, private repos included** (requested by the Professor, 2026-10-01; plan to be confirmed, depends on B2 option C).
  - Today only public diagrams reach the browse index (`updatePublicBrowseIndexForSuccessfulDiagram` in `src/server/storage/generation-persistence.ts`), and private diagrams are stored under a namespace derived from the browser PAT (`createPatNamespace` in `src/server/storage/cache-key.ts`), so another token cannot read them.
  - Index entries gain `visibility` (public or private) and `createdBy` (one operator id now; a user id once multi-user access exists). Every successful diagram is indexed.
  - Private storage key from `CACHE_KEY_SECRET` plus owner/repo, not the PAT (B2 option C), so any viewer whose token can read the repo can open the stored diagram.
  - Access check for private entries: the viewer's PAT must read the repo on GitHub (`GET /repos/{owner}/{repo}` 200, or one `GET /user/repos` listing per page, cached a few minutes per token HMAC). The diagram page, `/api/diagram-state` and the hover preview enforce it, not only the list.
  - Browse shows a Private badge. DECISION NEEDED: a private entry the viewer cannot read is (a) listed by name, locked and not clickable (the Professor's idea), or (b) hidden. With multiple users, (a) reveals client repo names to other users.
  - Migration: existing private diagrams under PAT namespaces are regenerated (few exist).
- [ ] B5. Add a reusable gate script (tests, tsc, eslint, `format:check` scope, knip, using this machine's working invocations) so agents stop retyping it.

## Verification (the whole fork)
- `bun run check`, `bun run test` and `bun run build` pass. Remove the knip and perf-budget entries for deleted code.
- Unit tests:
  - SQLite stores against a temp `DATA_DIR`;
  - each adapter with a faked SDK client;
  - the proxy gate;
  - error redaction;
  - the SSE flusher.
- Egress: run `node .next/standalone/server.js` locally with LM Studio and a private repo. Only `api.github.com` may show in `Get-NetTCPConnection`.
- Grep: no remaining `posthog`, `upstash`, `r2.cloudflarestorage`, `x-vercel-`, `presence` or `sponsor`, and `openrouter.ai` only in `voice.ts`.
- Host smoke test:
  - sign in;
  - a private diagram generates with each provider (only after the TLS gate);
  - the SSE is incremental;
  - it survives an app pool recycle;
  - a public video plays;
  - the MP4 routes answer 501 cleanly.

## Local-first target (2026-09-29, the Professor)
Build and verify on localhost first; deploy to the host once the TLS gate clears.
- The local machine has Windows, nvm-windows, **Node 24.21.0** (`nvm use 24`; `node:sqlite` works), Bun 1.4.2, Chrome, ffmpeg on the PATH, and LM Studio (`lms`, an OpenAI-compatible API on port 1234).
- Phase order: 2 â†’ 3 â†’ 5 â†’ 4 â†’ 6 â†’ 7 â†’ 8. Phase 5 comes before Phase 4, because the sign-in guard and session generation live in SQLite.
- The local definition of done: `bun run dev` on localhost with only `DATA_DIR`, `OPERATOR_TOKEN` and `AI_*` set. A private repo diagram generates through LM Studio, and the only remote connection is `api.github.com`.

### Local environment and baseline (2026-09-29)
- `package.json` says `engines.node: 22.x`; update it in step 32.
- Bun is 1.4.2 locally, but the project pins `bun@1.3.14`. `bun install` under 1.4.2 rewrites `bun.lock` to lockfileVersion 3 (format churn only); do not commit that. Use `bunx bun@1.3.14 install`. The `prepare` script's `>/dev/null 2>&1` fails in Bun's Windows shell, so git hooks are not installed locally.
- Typecheck: `node node_modules/typescript-7/bin/tsc --noEmit` (the bun shim fails on Windows).
- **Do not call `python3`.** On this machine it is the Microsoft Store stub (`WindowsApps\python3.exe`), which hangs forever waiting for input. Real Python is `python` (3.12). On 2026-09-29, three agent commands of the form `python3 - <<script || node -e …` hung for more than 20 minutes. Claude stopped them innermost shell first, so the `|| node` fallbacks never replayed old edits. For scripted file edits, use `node` or the edit tools.
- **Do not call `cmd.exe /c …` from Git Bash.** MSYS turns `/c` into a drive path, so cmd.exe opens an interactive shell and hangs (2026-09-30: a ripwire call hung, and the agent's `until` waiter loops hung with it; Claude stopped them). From bash, run `ripwire.cmd . --doc-drift`; from PowerShell, `ripwire . --doc-drift`. Run checks in the foreground, not behind background waiter loops.
- Baseline on `main` code: `bun run test` has 1259 passing, 5 failing, 4 suites failing, all environment-related:
  - `explainer/store.test.ts` (2): local store keys use `path.join`, which gives `\` on Windows. **This is a real bug for a Windows host; fix it in step 20.**
  - 4 `*.redis.test.ts` suites: there is no local `redis-server`. They are removed in Phase 5.
  - `explainer/voice.test.ts` (1): the fake ffmpeg is a `/bin/sh` script. Make it portable in step 29.
  - `sponsor-readme` and `sponsor-creative` (2): CRLF checkout. Deleted in Phase 2.
- Line endings: **resolved 2026-09-29.** `.gitattributes` (`* text=auto eol=lf`, CRLF for `*.cmd`/`*.bat`) was added, and `format:write` normalized the working copy. `format:check` exits 0. Nothing is staged.
- TDD roles: the Professor has no test-writer or implementer agent defined. Use general-purpose (sonnet) agents in those roles, in sequence.

## Handoff log
- 2026-09-28, Claude Code: created the branch and this tracker. Phase 1 probe files are written (`deploy/spike/`).
- 2026-09-28, Claude Code: the NodeJS Manager asks for a startup file and scans it for `listen(process.env.PORT || 3000)`. The probe became `server.js` with a sibling CommonJS `package.json`, and its settings come from `probe.config.json`.
- 2026-09-29, Claude Code: moved to the local-first target. Installed Node 24 with nvm and recorded the test baseline. Wrote the Phase 2 tests: `src/server/fork-isolation.test.ts` (scans for removed features; the allowlist has `readme-images.ts` for "sponsor" logo filtering) and `src/server/next-config-csp.test.ts` (connect-src is `'self'` only).
- 2026-09-29, Claude Code: **Phase 2 code done** (steps 6 to 9). 64 files changed and many deleted: sponsors, PostHog, the presence Worker, the Claude credit panel, and `gate-notice.ts`. `posthog-js` is gone from `bun.lock` (written with `bunx bun@1.3.14 install`). `providers.tsx` now exports `AppProviders`. `deploy/**` is excluded from eslint, knip and tsconfig. Lint, knip and tsc pass. `bun run test` has 1106 passing, and only the baseline environment failures remain. Still open: `CLAUDE.md` still describes the removed features (step 34), and the `sign-in-guard` `announce` field is now unused (rewritten in Phases 4 and 5).
- 2026-09-29, Claude Code: **Phase 2 docs done** (an anchored-docs delta by a sonnet agent). Deleted the sponsor-measurement, operations/posthog, operations/sponsor-clicks and sponsor-preview-images docs. `flows/operator-live-ops.md` is rewritten as "Operator dashboard". Agent-reported results: ripwire 0.6.0, drift=0 on the touched docs, STE warn(61 heuristic). `vuln-scan-2026-09-28.md` still lists `workers/presence/**` in `sources` (an okf notice, accepted). Afterwards `ANTHROPIC_ADMIN_KEY` was removed from `.env.example`, and `.env.example` was added to the `fork-isolation.test.ts` scan. **Not re-run yet:** the isolation test after that edit, and independent ripwire and STE passes.
- 2026-09-29, Claude Code (probe session): probe run on the host; results are in the Phase 1 table. Key findings: the host buffers SSE below ~8 KB (step 24b), only `App_Data` is writable (step 17), a forgeable client IP (step 15), MP4 disabled (step 31), and the TLS gate. The tracker was condensed and the steps amended to match. The two sessions are merged: this session resumes the local-first work, starting with the Phase 2 review (9r).
- 2026-09-29, Claude Code: **Phase 2 review done** (9r); one regression fixed (the sponsor-picture rule in `shot-prompt.ts`). Next: Phase 3.
- 2026-09-29, Claude Code: added `.gitattributes` (LF) and ran `format:write`; `format:check` passes and nothing is staged. **Note:** an attempt to refresh git's index by re-adding unchanged files wrongly staged 85 Phase 2 deletions; they were unstaged right away (`git restore --staged`), so the index is unchanged. Phase 3 scope decisions are written above. The **Phase 3 test-writer** (a sonnet agent) is running. Do not edit the Phase 3 test files in parallel.
- 2026-09-29, Claude Code: the Professor asked to start Phase 4 early. Only **steps 16 and 16b** run in parallel (`robots.ts`, `sitemap.ts`, `layout.tsx`, `proxy.ts` or `next.config.js` headers). Their test-writer (a sonnet agent) is running. Steps 13 to 15 wait for Phase 5 (SQLite) and for Phase 3 to finish with the shared files.
- 2026-09-29, Claude Code: the 16/16b test-writer finished. 16b needed no code: `next.config.js` already sends HSTS (`max-age=63072000; includeSubDomains; preload`). Claude corrected a mistake in its own brief: `includeSubDomains` from `gitdiagram.tuple.pro` covers only that host and names below it. `next-config-hsts.test.ts` now guards the existing header (it passes).
- 2026-09-29, Claude Code: **Phase 5 complete** (verified; see Phase 5). Cleaned up three hung agent shells (the `python3` Store stub; see the baseline notes). **Running in parallel now:** the docs pass for Phases 3+5 (a sonnet agent; `docs/**` plus comment-only JSDoc in `db`, `object-store`, `kv` and `fs-safety`), and the Phase 4 steps 13 to 15 test-writer (a sonnet agent; tests only). The Phase 4 design is written under Phase 4.
- 2026-09-29, Claude Code: **stopped because the usage limit was reached.** The Phase 4 steps 13 to 15 test-writer finished (see Phase 4, including 3 DECISION NEEDED items). **The docs pass for Phases 3+5 was stopped partway**, so `docs/**` and the comment-only JSDoc in `db`, `object-store`, `kv` and `fs-safety` may be half-edited. Next session: check `git diff -- docs`, then re-run the docs pass from the start (anchored-docs delta; ripwire drift=0 and STE 0 mechanical on the touched docs). Then run the Phase 4 implementer once the Professor answers the 3 decisions. The Phase 3 test-writer finished (see Phase 3). **Running in parallel:** the Phase 3 + step 16 implementer (a sonnet agent), and the Phase 5 "Now" test-writer (a sonnet agent; the file sets are disjoint and listed in each brief).
- 2026-09-29, Claude Code: the Phase 5 "Now" test-writer finished; its points are decided under Phase 5. **Running in parallel now:** the Phase 3 + step 16 implementer, and the Phase 5 "Now" implementer (steps 17, 18a, 19, 21, the `cache-key.ts` bucket names, the `catalog.test.ts` fix). The file sets are disjoint; `.env.example` is shared, with line-local edits only.
- 2026-09-29, Codex: resumed after Claude's usage limit. The Phase 4 test-writer completed, and the implementer finished steps 13 to 15. Operator sessions now use SQLite and a random installation nonce signed into v3 cookies; v1/v2 cookies are rejected, and a recreated database invalidates old sessions. The global wrong-token counter ignores forgeable client IP headers. Proxy and route checks gate private pages and APIs, with private/no-store caching. Focused auth/proxy tests pass (166/166), lint, direct TypeScript check, and the Node production build pass. The full suite has 1446 passing and the one established Windows voice failure (`spawn /bin/sh ENOENT`). The Phase 4 anchored-docs delta passed OKF and Ripwire (0 live drift); changed living docs have 0 mechanical STE findings. Next: Phase 6 step 22.
- 2026-09-30, Codex: Phase 6 steps 22 to 24 are complete. The provider interface and OpenAI Responses, Anthropic, and OpenAI-compatible Chat adapters are in use by the diagram stream, graph, and cost paths. Provider configuration has Gemini and Grok presets. The operator's `AI_API_KEY` uses standard billing; an unbound caller key cannot reach a non-OpenAI adapter. Invalid provider configuration fails readiness before storage access. Focused provider and route tests pass (100/100), as do direct TypeScript, lint, formatting, and diff checks. Anchored-docs deltas passed OKF, STE mechanical checks, and Ripwire with no live drift. The unknown-model pricing gate remains until step 25. Next: step 24b SSE host flusher; its red tests are written.
- 2026-09-30, Codex: Phase 6 step 24b is complete. The SSE writer batches for at most 250 ms, pads each host batch by encoded byte length, sends a padded idle heartbeat every 15 s, and clears timers on close or cancellation. `SSE_FLUSH_PAD_BYTES` defaults to 0 and accepts 0 to 65536; the host must set 9216 explicitly. Focused SSE tests pass (43/43), as do direct TypeScript and diff checks. The anchored-docs delta passed OKF and Ripwire with 0 live drift and 0 mechanical STE findings. Next: step 25 unknown-model pricing; red tests are in progress.
- 2026-09-30, Codex: Phase 6 step 25 is complete. Unknown or local models retain token counts and report `amountUsd: null` with display `n/a`; the stream and cost routes continue without a known USD rate. Pricing uses the selected provider and exact known OpenAI model IDs or dated snapshots. The cost route estimates tokens locally when a provider counter is unavailable. Independent focused tests pass (83/83 across eight suites), as do direct TypeScript, lint, formatting, and diff checks. The anchored-docs delta passed OKF and Ripwire with 0 live drift and 0 mechanical STE findings. Next: step 26 credential binding, pending. Stopped after step 25 at the Professor's request.
- 2026-09-30, Claude Code: resumed Phase 6 with sonnet agents. **Line A:** the step 26 test-writer is running (then its implementer, then step 27, sequential because both touch the stream and cost routes). **Line B:** the step 27b test-writer is running in parallel (source-context, source-excerpt, repository-context and a new secret-scan module; disjoint from line A). Do not edit those files in parallel. Reviewing the 3 Phase 4 decisions with the Professor.
- 2026-10-01, Claude Code (docs agent): steps 5 and 34 done. New `docs/deployment.md` and `docs/decisions/0003-self-hosted-single-operator.md`; `docs/deployment-failover.md` is now a short recovery page (the stale marker is cleared). Phase 8 delta across configuration, architecture, dev-setup, overview, index, glossary, map and log; `CLAUDE.md` is rewritten for the fork (76 lines, the Next.js block is kept). Ripwire 0.6.0: drift=0 on the touched docs. STE: 0 mechanical. OKF: 0 findings. Open: `.env.example` still names `openrouter` as an `AI_PROVIDER` value in a comment, but the code accepts openai, anthropic, gemini, grok and openai-compatible; fix it in code, not in docs.
- **2026-10-01, Claude:** reviewed step 34. Removed the last `VERCEL_*` reads (`AdminState.deployment` in `src/server/admin/state.ts`, its type, the dashboard header and three test fixtures; a new test in `state.test.ts`), and fixed the `AI_PROVIDER` comment in `.env.example` (it named `openrouter`). Gate: 1774/1774 tests; tsc, lint, format:check, knip exit 0. **Phase 8 is complete; every plan step is done.** Remaining work is on the host (see `docs/deployment.md`).
- **2026-10-01, Claude (first host deploy):** Gemini failed the graph step with `400 INVALID_ARGUMENT` on the strict `json_schema`; the Chat adapter fallback did not match that wording. Fixed in `src/server/ai/openai-chat.ts` (`invalid.argument` added to `SCHEMA_REJECTION_PATTERN`), with two tests. Follow-ups: (1) a private repo needs the PAT in the browser; the server `GITHUB_PAT` does not cover private repos (options A/B/C put to the Professor); (2) `src/server/generate/errors.ts` still holds the upstream "solo student engineer" quota message; (3) a graph-step failure is recorded with failure stage `explanation`.
- **2026-10-01, Claude (second host run):** after the fallback fix, Gemini failed with "Model returned invalid structured output." The prompt-mode fallback gave only the top-level field names of the graph schema. `parseStructured` in `src/server/ai/openai-chat.ts` now puts the whole JSON Schema (without `$schema`, about 1,720 characters) in the fallback prompt, reads JSON inside a Markdown fence (`jsonText`), and sends path plus message for up to five validation issues. Three tests added. Gate: 1779/1779; tsc, lint, format:check, knip exit 0.
- **2026-10-01, Claude (host incident):** after a redeploy, 502 with `EADDRINUSE` (an old Node held the port; fixed by restarting the app pool), then a false 15-minute sign-in lockout. Cause: the NodeJS Manager had overwritten `web.config`, so `HOSTNAME`, `DATA_DIR` and `SSE_FLUSH_PAD_BYTES` were missing (Node listened on `0.0.0.0`). The Professor restored it. `docs/deployment.md` now covers both; backlog B6 added.
- **2026-10-01, the Professor (host):** first successful private repo diagram on `gitdiagram.tuple.pro` with `AI_PROVIDER=gemini` (package `gitdiagram-iis-20261001-1127.zip`, browser PAT, restored `web.config`). Still open on the host: the egress check, an app pool recycle survival check, the probe removal, certificate renewal.
- **2026-10-01, Claude (browse 401):** the browse index, the browse hover preview, the video catalog, reels and generation cancel all used upstream `credentials: "omit"`, so the operator gate answered 401 (cancel failed silently). All five now use `same-origin`; tests flipped and a guard test added (`src/server/api-fetch-credentials.test.ts`). Gate: 1780/1780; tsc, lint, format:check, knip exit 0. Package `artifacts/gitdiagram-iis-20261001-1148.zip`. Backlog B9 added (browse redesign).
- **2026-10-01, Claude (browse empty):** with only a private diagram, browse showed "index currently unavailable in storage": reads threw `BrowseIndexNotFoundError` when no index file existed (a Phase 5 carry-over). `readBrowseIndex` now returns `[]` and `getBrowsePage` gives an empty page; the error message in `browse-catalog.tsx` no longer says "hosted". Two tests updated deliberately (`browse-diagrams.test.ts`). Gate: 1780/1780; tsc, lint, format:check, knip exit 0.
- **2026-10-02, Claude (stars filter removed):** at the request of the Professor, the minimum-stars filter is gone from browse and (option B, the Professor) from the video gallery, reels and `/api/video/catalog`; sort by stars and row star counts stay; a legacy `?minStars=` is ignored and stripped from the browse address. Test-writer then implementer (Sonnet); video tests updated only to drop the filter expectations. Gate: 1787/1787; tsc, lint, format:check, knip exit 0. Open: why a public diagram did not appear in browse (waiting for the `generate.post_response.finished` and `Failed to update browse index` lines from the host `node.log`).
- **2026-10-03, Claude (session end):** the Professor confirmed that browse lists the public diagram after the 20261002-1322 package, so the earlier miss is closed without the log (most likely the 60-second browser cache of `/api/browse-index` or the pre-fix build). The Professor is committing the fork. Next session: backlog B1 to B9 (B2 and B9 need decisions; B7 and B8 were proposed: a startup warning for missing `HOSTNAME`/`SSE_FLUSH_PAD_BYTES`, and operator-set AI prices), plus the host checks (recycle survival, probe removal, certificate renewal).

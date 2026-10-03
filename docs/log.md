# Docs update log

## 2026-10-02

- **Change**: browse, the video gallery, reels and the video catalog API have no minimum-stars filter. A `minStars` URL value is ignored, and the browse page removes it from the address. Sort by stars stays. No doc described the filter.

## 2026-10-01

- **Update**: [Artifact storage](flows/artifact-storage.md) says that the browse index is empty, not missing, before the first public diagram.
- **Fix**: browser calls to the browse index, the hover preview, the video catalog, reels and generation cancel send the session cookie (`credentials: "same-origin"`). The operator gate refused them before. No doc described the old value.
- **Update**: [Deploy to the IIS host](deployment.md) says to stop the app pool before the extract, to check `web.config` after each start, and gives three host failures: `EADDRINUSE` with 502, a sign-in block with no log event, and the `0.0.0.0` listen address.
- **Update**: [Diagram generation](flows/diagram-generation.md) says that the Chat adapter fallback gives the whole JSON Schema, reads fenced JSON, and sends the problem of each validation error.
- **Update**: [Diagram generation](flows/diagram-generation.md) describes the schema fallback of the Chat adapter, which now also starts on the Gemini invalid-argument refusal.
- **Update**: [Operator dashboard](flows/operator-live-ops.md) says that the admin state gives no deployment commit or region (private fork phase 8, the last `VERCEL` reads removed).
- **Addition**: [Deploy to the IIS host](deployment.md) and [ADR 0003](decisions/0003-self-hosted-single-operator.md) describe the packaging, the host settings, the application pool secrets, and the decision to self-host for one operator (private fork phase 8, steps 5 and 34).
- **Update**: [Host recovery](deployment-failover.md) replaces the stale Railway recovery page. [Configuration inventory](configuration.md), [application architecture](architecture.md), [development setup](dev-setup.md), [system overview](overview.md), the index, and the glossary describe standalone output, the IIS package, the tracing excludes, `SITE_URL`, the `engines` range, and the removed star fetch, `RAILWAY_DOCKER_BUILD`, and `VERCEL_*` reads (private fork phase 8, steps 32 and 33).
- **Update**: [Configuration inventory](configuration.md), [explainer video](flows/explainer-video.md), [application architecture](architecture.md), and [deployment recovery](deployment-failover.md) describe `VIDEO_RENDER_ENABLED`, the 501 render answer, the skipped poster, the `renderEnabled` field, the removed `VERCEL` reads in render code, and the production segment limit of 1 (private fork phase 7, steps 29 to 31).

## 2026-09-30

- **Update**: [Diagram generation](flows/diagram-generation.md) describes `redactLogText` and `errorText`, and the log calls that use them (private fork phase 6, step 27).
- **Update**: [Operator dashboard](flows/operator-live-ops.md), [explainer video](flows/explainer-video.md), [application architecture](architecture.md), [configuration inventory](configuration.md), [development setup](dev-setup.md), [deployment recovery](deployment-failover.md), [artifact storage](flows/artifact-storage.md), and the glossary describe the removed Bearer access, the health check that needs no session, the sign-in block event, the removed pause switch, the voice-credit check for the operator, and the explicit `regenerate` flag (private fork phase 4, decisions 1 to 4).
- **Update**: [Configuration inventory](configuration.md) describes the caller API key cookie, its provider and endpoint binding, the ignored legacy cookie, and the provider fields of the credential status (private fork phase 6, step 26).
- **Update**: [Diagram generation](flows/diagram-generation.md) describes the secret scan of source files and the README, and the `redactedSecretCount` audit field (private fork phase 6, step 27b).
- **Update**: [Diagram generation](flows/diagram-generation.md), [configuration inventory](configuration.md), [application architecture](architecture.md), and [development setup](dev-setup.md) describe provider-aware pricing, nullable USD cost, and continued token usage when a model has no known rate (private fork phase 6, step 25).
- **Update**: [Diagram generation](flows/diagram-generation.md), [configuration inventory](configuration.md), [application architecture](architecture.md), and [development setup](dev-setup.md) describe padded SSE batches, heartbeats, the client comment parser, and the host value for `SSE_FLUSH_PAD_BYTES` (private fork phase 6, step 24b).
- **Update**: [Diagram generation](flows/diagram-generation.md), [configuration inventory](configuration.md), [application architecture](architecture.md), and [development setup](dev-setup.md) describe the wired provider adapters, provider token counts, local token fallback, and the remaining unknown-pricing gate (private fork phase 6, step 24).
- **Update**: [Configuration inventory](configuration.md), [development setup](dev-setup.md), [application architecture](architecture.md), and [system overview](overview.md) describe the provider settings, the active OpenAI-only generation path, and readiness checks (private fork phase 6, step 23).

## 2026-09-29

- **Update**: [Diagram generation](flows/diagram-generation.md) describes the provider interface and adapters. The stream route and graph planner still use `src/server/generate/openai.ts` (private fork phase 6, step 22).
- **Update**: [Operator dashboard](flows/operator-live-ops.md), [configuration inventory](configuration.md), [application architecture](architecture.md), [system overview](overview.md), [development setup](dev-setup.md), and [traffic protection](operations/traffic-protection.md) describe the operator gate, SQLite session generation and installation nonce, the global sign-in counter, token configuration, route protection, and private cache headers (phase 4, steps 13 to 15).
- **Correction**: [Security audit](vuln-scan-2026-09-28.md) and [security remediation](security-remediation-2026-09-28.md) retain their 2026-09-28 findings and no longer list deleted deployment or presence-worker sources.
- **Update**: [Artifact storage](flows/artifact-storage.md) describes SQLite and local disk in `DATA_DIR`, with the schema, file layout, key rules, conditional writes, and transaction behavior (private fork phase 5).
- **Update**: [Explainer video](flows/explainer-video.md) drops audience, geographic, and budget rules, and adds the paid-run cap, the reserved-name check, and MP4 streaming with Range support (phases 3 and 5).
- **Update**: [Operator dashboard](flows/operator-live-ops.md) shows only the pause switch and the voice balance. The reset route is removed (phase 3).
- **Update**: [Diagram generation](flows/diagram-generation.md) drops the daily gate and the rate limiters (phase 3).
- **Update**: [Architecture](architecture.md), [overview](overview.md), [configuration inventory](configuration.md), [development setup](dev-setup.md), [traffic protection](operations/traffic-protection.md), and the glossary follow the same changes. `DATA_DIR` is added and the R2, cron, and quota keys are removed.
- **Deprecation**: [Offline Railway recovery](deployment-failover.md) is deprecated and marked stale, because the Vercel, Railway, and Docker files are removed. [Private diagram storage](decisions/0001-private-diagram-storage.md) and [video admission](decisions/0002-video-admission-redis.md) are marked superseded.
- **Deletion**: Sponsor measurement, PostHog, sponsor click, and sponsor preview docs are removed. The code for those features is removed in private fork phase 2.
- **Update**: [Operator dashboard](flows/operator-live-ops.md) drops presence, the live feed, and the Claude credit panel.
- **Update**: [Architecture](architecture.md), [overview](overview.md), [configuration inventory](configuration.md), [development setup](dev-setup.md), [deployment recovery](deployment-failover.md), and the glossary drop the removed analytics, sponsor, and presence Worker parts.

## 2026-09-28

- **Initialization**: [System overview](overview.md), [application architecture](architecture.md), [configuration inventory](configuration.md), and [flow index](flows/index.md) start the source-anchored bundle.
- **Update**: Legacy operations (since removed) and [development setup](dev-setup.md) have source-backed OKF metadata.
- **Creation**: [Security audit](vuln-scan-2026-09-28.md) records findings and outbound data paths.
- **Creation**: [Security remediation](security-remediation-2026-09-28.md) records self-hosting actions and choices.
- **Update**: [Security audit](vuln-scan-2026-09-28.md) records the SkillSpector follow-up and its limits.

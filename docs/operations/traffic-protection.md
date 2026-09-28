---
type: Runbook
title: Traffic protection
description: How repository pages and social images use caches, and where operators inspect firewall rules.
diataxis: explanation
status: draft
sources:
  - id: repository-page
    resource: src/app/*/*/page.tsx
  - id: repository-image
    resource: src/app/*/*/opengraph-image/route.ts
  - id: repository-image-render
    resource: src/server/og/cards.tsx
  - id: repository-cache-paths
    resource: src/server/storage/repo-page-cache.ts
  - id: generation-invalidation
    resource: src/server/storage/generation-persistence.ts
  - id: route-normalization
    resource: src/proxy.ts
  - id: next-routes
    resource: next.config.js
  - id: deployment-config
    resource: vercel.json
generated: { by: openai/gpt-6, at: 2026-09-28T19:30:26Z }
verified:
  - { by: openai/gpt-6, at: 2026-09-28T19:30:26Z }
---

# Traffic protection

`Repo` in `src/app/[username]/[repo]/page.tsx` sets a six-hour cache time for the page and its stored diagram data. If a storage read has an error, the page cache time is one minute. `persistGenerationResult` in `src/server/storage/generation-persistence.ts` clears the normalized and input page paths, their image paths, and the data tag after generation ends without error.

`GET` in `src/app/[username]/[repo]/opengraph-image/route.ts` sets a one-day image refresh time. `createRepoSocialImage` in `src/server/og/cards.tsx` sets a five-minute browser cache and a one-day CDN cache. The metadata fields use the Open Graph image. `redirects` in `next.config.js` sends the Twitter image path to `route.ts`.

`proxy` in `src/proxy.ts` sends repository page and image paths that have capital letters to `lowercase`. `getRepoPagePath` in `src/server/storage/repo-page-cache.ts` makes the `lowercase` path and cache tags.

The repository does not set Vercel firewall rules. `vercel.json` sets a browse index drain schedule and memory for video segment data. Check the Vercel project before you use a firewall rule name, condition, or step.

The prior firewall record names `Amazonbot`, `Brightbot`, and repository traffic rules. The code does not include these rules. Read the live Vercel project before you change a rule.

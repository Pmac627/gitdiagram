---
type: Runbook
title: Traffic protection
description: How repository pages and social images use caches, and how the app keeps crawlers out.
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
  - id: crawler-rules
    resource: src/app/robots.ts
  - id: root-layout
    resource: src/app/layout.tsx
generated: { by: codex/gpt-6, at: 2026-09-29T22:01:56Z }
verified:
  - { by: openai/gpt-6, at: 2026-09-28T19:30:26Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T18:00:00Z }
  - { by: codex/gpt-6, at: 2026-09-29T22:01:56Z }
---

# Traffic protection

`Repo` in `src/app/[username]/[repo]/page.tsx` sets a six-hour cache time for the page and its stored diagram data. If a storage read gives an error, the page cache time is one minute. `persistGenerationResult` in `src/server/storage/generation-persistence.ts` clears the normalized and input page paths, their image paths, and the data tag after generation ends without error.

`GET` in `src/app/[username]/[repo]/opengraph-image/route.ts` sets a one-day image refresh time. `createRepoSocialImage` in `src/server/og/cards.tsx` sets a five-minute browser cache. The metadata fields use the Open Graph image. `redirects` in `next.config.js` sends the Twitter image path to `route.ts`.

`proxy` in `src/proxy.ts` sends repository page and image paths that have capital letters to `lowercase`. It also checks the operator session before a page or API route gets a request. `getRepoPagePath` in `src/server/storage/repo-page-cache.ts` makes the `lowercase` path and cache tags.

## Crawlers

`robots` in `src/app/robots.ts` disallows all paths for all user agents. The app has no sitemap route.
The `robots` metadata in `src/app/layout.tsx` sets `index` and `follow` to `false` for all pages.

## Removed parts

The private fork removed `vercel.json` and the Vercel firewall notes.
It also removed the CDN cache headers `CDN-Cache-Control` and `Vercel-CDN-Cache-Control`.
The app does not send a `Vercel-Cache-Tag` header. Cache clearing uses the Next.js path and tag functions only.

The proxy sends a no-store response for sign-in redirects and API requests without a session. The proxy sets `Cache-Control: private, no-store` on responses that it lets through.
Route handlers send caller-specific data with `private` or `no-store` cache directives. Versioned video files can use `immutable`.

---
type: Runbook
title: PostHog usage and replay
description: How the app sends browser, video, and sponsor data to PostHog.
diataxis: explanation
status: draft
sources:
  - id: posthog-client
    resource: src/lib/analytics-client.ts
  - id: posthog-routing
    resource: next.config.js
  - id: analytics-startup
    resource: src/app/providers.tsx
  - id: analytics-context
    resource: src/app/api/analytics-context/route.ts
  - id: video-analytics
    resource: src/features/explainer/watch-analytics.ts
  - id: sponsor-analytics
    resource: src/server/sponsor-clicks.ts
generated: { by: openai/gpt-6, at: 2026-09-28T19:29:07Z }
verified:
  - { by: openai/gpt-6, at: 2026-09-28T19:29:07Z }
---

# PostHog usage and replay

The app sends data to `/phx9a`. `getPostHog` in `src/lib/analytics-client.ts` sets the host. `rewrites` in `next.config.js` sends this path to PostHog.

`CSPostHogProvider` in `src/app/providers.tsx` waits for `migrateLegacyCredentialStorage`. Then it sends page views. If migration is not complete, analytics stays off.

`getPostHog` enables `autocapture`, `capture_pageleave`, `capture_dead_clicks`, `rageclick`, `capture_heatmaps`, `web_vitals`, and `capture_exceptions`. It turns off `capture_console_errors`, `network_timing`, and `disable_surveys`. The client applies `maskAllInputs` to all inputs. Replay does not record `.ph-no-capture`, hidden inputs, or file inputs.

`GET` in `src/app/api/analytics-context/route.ts` sends valid country and region codes. The API does not send an IP address. `getReplayRegion` uses these codes for flag properties. If data is not available, the API keeps the country and region properties empty.

Remote PostHog `session_recording` `settings` control sample rates. The client comments record a 100 percent rate and no minimum time. The source does not show these remote `settings` or account `billing`. An operator checked them on September 25, 2026.

The September 25 operator record reports US$50,000 in startup credits. It reports that `posthog_ai`, `inbox`, `replay_vision`, and `posthog_code_usage` had `$0` limits. It reports that ten other PostHog limits were removed. Credits can end. The source does not stop `billing` when credits end. Read the PostHog account record before you change a limit.

`WatchTracker` in `src/features/explainer/watch-analytics.ts` sends `video_started` at first play. It sends `video_progress` at 25, 50, 75, and 100 percent of play time. The 100 percent mark is at 97 percent play time. A `seek` adds no time to the count.

`recordSponsorEvent` in `src/server/sponsor-clicks.ts` sends `sponsor_click` and `sponsor_impression` from the server. The data does not contain the visitor IP. GeoIP enrichment is off. See [sponsor reporting](./sponsor-clicks.md).

A browser can prevent JavaScript, storage, or network access. As a result, analytics can stop. The app sets `capture_pageview: false` and sends page views from `CSPostHogProvider`.

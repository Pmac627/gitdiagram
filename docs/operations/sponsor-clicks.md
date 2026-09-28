---
type: Runbook
title: Sponsor campaign reporting and scheduling
description: How the sponsor schedule serves placements and records impressions and outbound clicks.
diataxis: explanation
status: draft
sources:
  - id: sponsor-schedule
    resource: src/lib/sponsor-campaign.ts
  - id: sponsor-client
    resource: src/hooks/use-sponsor-campaign.ts
  - id: sponsor-status
    resource: src/app/api/sponsor/route.ts
  - id: sponsor-impressions
    resource: src/hooks/use-sponsor-impression.ts
  - id: sponsor-routes
    resource: src/app/out/**
  - id: sponsor-capture
    resource: src/server/sponsor-clicks.ts
  - id: sponsor-reporting
    resource: src/server/sponsor-stats.ts
generated: { by: openai/gpt-6, at: 2026-09-28T19:29:07Z }
verified:
  - { by: openai/gpt-6, at: 2026-09-28T19:29:07Z }
---

# Sponsor campaign reporting and scheduling

`scheduledSponsorCampaigns` in `src/lib/sponsor-campaign.ts` includes Sent and CodeRabbit. `activeSponsorCampaign` selects a campaign between its start and end times. The schedule test rejects overlap.

`SponsorCampaignProvider` in `src/hooks/use-sponsor-campaign.ts` reads `/api/sponsor` with no cache. It uses server time and sets the next change. An error starts a retry after 30 seconds. The app uses the server-rendered campaign until it gets the first response.

## Website impressions

`useSponsorImpression` in `src/hooks/use-sponsor-impression.ts` records one `impression` for each campaign and placement during a pathname visit. The function records it when the ad loads, below the fold too. `useSponsorImpression` uses no viewport check or wait period.

`POST` in `src/app/out/[campaign]/impression/route.ts` accepts same-origin JSON with a website placement and page view ID. `route.ts` does not record a campaign when it is not active, unless an admin test applies. `shouldRecordSponsorEvent` checks the host, user agent, prefetch, DNT, and GPC values.

`claimSponsorEvent` in `src/server/sponsor-clicks.ts` uses Redis for page view dedupe. It limits `impressions` to 120 for a network and campaign in each hour. The default campaign limit is 100,000 in each hour. If Redis is not available, `route.ts` records the `impression` without dedupe.

## Outbound clicks

`GET` in `src/app/out/[campaign]/route.ts` checks the campaign and placement. On a production host, a campaign URL before its start time or at its end time goes to `/advertise`. `GET` does not count it as a click. An active campaign sends the visitor to its destination in code. URL input cannot set the destination.

`shouldRecordSponsorClick` in `src/server/sponsor-clicks.ts` skips data that is not a navigation. `route.ts` checks host, user agent, prefetch, DNT, and GPC values. `HEAD` does not count.

`route.ts` uses `after` to record a click after it sends the redirect. `claimSponsorEvent` dedupes clicks by network, campaign, and placement for 30 minutes. The default campaign limit is 5,000 clicks each hour. If Redis is not available, `route.ts` records the click without dedupe. Capture stops after three seconds.

`recordSponsorEvent` sends campaign, sponsor, placement, and test status to PostHog. The data does not contain the visitor IP. It sets `$process_person_profile` to `false` and `$geoip_disable` to `true`. See [PostHog data collection](./posthog.md).

## Campaign schedule

The code includes `sent-2026-09` through October 19, 2026. It includes `coderabbit-2026-10` from the Sent end time through November 19, 2026. CodeRabbit paid time starts on October 20. The lead-in has no charge.

The campaign dashboards and fees in the earlier report are account records. The code has no dashboard URLs or campaign fees. Keep share tokens out of this repository.

`getSponsorStats` in `src/server/sponsor-stats.ts` reads PostHog and GitHub data for `/advertise`. It caches recent stats for one hour and lifetime stats for one day. If a refresh has an error, the cache keeps the last good value. If the read has no cache, the page uses a snapshot from September 17, 2026.

The code has no `50/50 rotation`. `activeSponsorCampaign` selects one campaign. Do not schedule overlap.

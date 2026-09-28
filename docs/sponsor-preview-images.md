---
type: Runbook
title: Sponsor placement screenshots
description: Capture dates, image paths, and preview dimensions for sponsor placement images.
diataxis: reference
date: 2026-09-20
status: draft
sources:
  - id: sponsor-content
    resource: src/app/advertise/sponsor-content.ts
  - id: sponsor-preview
    resource: src/app/advertise/sponsor-placement-preview.tsx
  - id: sponsor-preview-style
    resource: src/app/advertise/sponsor-placement-preview.module.css
  - id: sponsor-page
    resource: src/app/advertise/page.tsx
  - id: sponsor-stats
    resource: src/server/sponsor-stats.ts
  - id: sponsor-images
    resource: public/sponsor-previews/*.png
generated: { by: codex/gpt-6-astra, at: 2026-09-28T19:25:59Z }
verified:
  - { by: codex/gpt-6-astra, at: 2026-09-28T19:22:09Z }
  - { by: codex/gpt-6-astra, at: 2026-09-28T19:25:59Z }
---

# Sponsor placement screenshots

The images in `public/sponsor-previews` show the production site on September 20, 2026. The capture showed the Sent campaign.

| Image | Source | Framing |
| --- | --- | --- |
| `home.png` | `https://gitdiagram.com/` | Homepage input and sponsor slot. |
| `diagram.png` | `https://gitdiagram.com/fastapi/fastapi` | Saved diagram and sponsor slot below it. |
| `browse.png` | `https://gitdiagram.com/browse?sort=stars_desc` | Catalog controls, first listings, and sponsor row. |
| `readme.png` | `https://github.com/ahmedkhaleel2004/gitdiagram` | README introduction, sponsor line, and Features heading. |

The images show approved web banners, a purple background, and the `sponsor label`. The README image shows the wordmark. The captures keep the initial page content.

The preview images are static. `createSponsorContent` in `src/app/advertise/sponsor-content.ts` sets each image path, dimension, and highlight area.

`SponsorPlacementPreview` in `src/app/advertise/sponsor-placement-preview.tsx` shows the highlight from the image dimensions. Keep the dimensions and highlight area in `sponsor-content.ts` aligned with each capture.

The sponsor page gets audience totals and placement pageviews from `getSponsorStats` in `src/server/sponsor-stats.ts`. That function uses cached PostHog and GitHub data when configured. It uses a dated snapshot if PostHog credentials are not available or a refresh does not succeed.

Refresh a capture when a placement changes. Capture at 2x pixel density. Add page content that shows the location. Keep `browser chrome` and development controls out of the crop. Update image dimensions and descriptions in `src/app/advertise/sponsor-content.ts` when they change.

The preview dialog has a red box around each sponsor slot. Its `highlight` values in `sponsor-content.ts` use image pixels. Update these values when a capture changes. The full-size `link` opens the initial image.

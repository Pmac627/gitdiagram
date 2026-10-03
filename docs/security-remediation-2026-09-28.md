---
type: Runbook
title: Security remediation, 2026-09-28
description: Actions to make this checkout safer for a controlled self-hosted deployment.
diataxis: how-to
status: draft
date: 2026-09-28
sources:
  - id: runtime
    resource: src/**
generated: { by: codex/gpt-6, at: 2026-09-28T18:30:21Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T18:30:21Z }
tags: [security, remediation, self-hosting]
---

# Security Remediation Guide

**Audit date:** 2026-09-28 18:00 UTC.
**Companion:** [Security audit](vuln-scan-2026-09-28.md).

## Priority

1. Limit access to the service before you set a host model key.
2. Make visitor keys specific to each provider before you let visitors use them.
3. Keep analytics, `presence`, and video off until you accept their data paths.
4. Add a secret check before source text goes to a model provider.
5. Reject admin sessions if Redis cannot check their revocation status.

## Findings and actions

### VULN-001: Visitor OpenAI key can go to OpenRouter

`resolveApiKey` in `src/server/generate/openai.ts:86` selects the visitor key for OpenAI or OpenRouter.

#### Choice A, recommended

Store different key types for OpenAI and OpenRouter.
Reject a visitor key if it is for a different provider.
Work: moderate.

#### Choice B

Disable the visitor key field when `AI_PROVIDER=openrouter`.
Use only the host OpenRouter key.
Work: low.

Selection A lets visitors pay for use of the two providers.
Selection B is simpler, but the host pays for all OpenRouter use.

### VULN-002: Anonymous callers can use host quota

`admitGenerationRequest` in `src/server/generate/request-admission.ts:65` does not identify users.

#### Choice A, recommended

Put the service behind your identity proxy or on a private network.
Limit access to your accounts.
Work: low to moderate.

#### Choice B

Add authentication and quotas for each user.
Work: high.

Selection A applies to a small group that you trust.
Selection B lets the public use the service, but you must manage sessions and accounts.

### VULN-003: PostHog receives URL and replay data

`getPostHog` in `src/lib/analytics-client.ts:39` starts PostHog if the client has a public key.

#### Choice A, recommended

Do not set `NEXT_PUBLIC_POSTHOG_KEY` in the arguments for the container image.
Do not set `POSTHOG_PERSONAL_API_KEY` in the environment at runtime.
Work: low.

#### Choice B

Keep analytics, but remove replay and full query strings before capture.
Examine all fields that PostHog receives.
Work: moderate.

Selection A stops this analytics data path.
Selection B keeps site measurements, but PostHog receives the data you select.

### VULN-004: Source excerpts can contain secrets

`isArchitectureSource` in `src/server/generate/repository-context.ts:21` examines names and types, but does not examine file contents.

#### Choice A, recommended

Use generation only with repositories that you can send to your model provider.
Examine private repositories before you use them.
Work: low.

#### Choice B

Add a check for secrets in file contents.
Prevent sensitive text from entering model prompts.
Add tests for secrets in ordinary source files.
Work: moderate.

Selection A gives repository owners control of their data.
Selection B decreases accidental disclosure, but a content scan cannot show that a file is safe.

Status: `redactSecrets` in `src/server/generate/secret-scan.ts` does Choice B. `fetchSourceContext` in `src/server/generate/source-context.ts` and `prepareRepositoryContext` in `src/server/generate/repository-context.ts` use it. See [Diagram generation](flows/diagram-generation.md).

### VULN-005: Revoked admin cookie can work during Redis outage

`verifyAdminSession` in `src/server/admin/operator.ts:136` accepts a signed cookie when the Redis generation is unknown.

#### Choice A, recommended

Reject admin sessions if Redis cannot check the generation.
Work: low.

#### Choice B

Use a local session store with durable revocation data.
Work: high.

Selection A can make the dashboard unavailable during a Redis outage.
Selection B adds one more service to operate.

## Egress choices

The app uses GitHub, a model provider, Cloudflare R2, and an Upstash-compatible REST service in production.
`checkReadiness` in `src/server/readiness.ts:24` checks the provider, storage, and Redis.
The code sets Cloudflare R2 in `src/server/storage/r2.ts:51` and OpenRouter in `src/server/generate/openai.ts:48`.
The [OpenAI SDK v7.23.0 source](https://github.com/openai/openai-node/blob/v7.23.0/src/client.ts) says `OPENAI_BASE_URL` changes its default endpoint.
Check API compatibility before you use a local model endpoint.

Add local storage and model adapters if you cannot use these services.
Then change the readiness checks.
Use accounts for GitHub, the model provider, R2, and Redis that agree with your access policy.
Set egress rules for the selected destinations.
Do a test of network traffic from start to end.

Video adds Anthropic, OpenRouter voice, OpenAI transcription, and public hosts with README images.
Keep `VIDEO_EXPLAINER_ENABLED` and `NEXT_PUBLIC_VIDEO_EXPLAINER` unset if video is not necessary.
Keep `NEXT_PUBLIC_PRESENCE_URL` unset if the Cloudflare `presence` worker is not necessary.
Change the initial site URLs and sponsor destinations before other users can use your service.

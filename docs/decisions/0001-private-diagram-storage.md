---
type: Decision
title: Private diagram storage
description: Superseded. Private diagram results use a token-derived namespace in a private R2 bucket.
diataxis: explanation
status: deprecated
date: 2026-09-28
sources:
  - id: location
    resource: src/server/storage/cache-key.ts
  - id: persistence
    resource: src/server/storage/generation-persistence.ts
generated: { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
  - { by: claude-code/claude-sonnet-5-5, at: 2026-09-29T18:00:00Z }
tags: [storage, privacy]
---

# Private diagram storage

> **Superseded on 2026-09-29** by the private fork storage change. Cloudflare R2 and its private bucket are removed. The token-derived namespace rule continues to apply and is in the [artifact storage flow](../flows/artifact-storage.md). The `private` bucket is the folder `DATA_DIR/objects/private`. This record keeps the initial text for history. See [ADR 0003](0003-self-hosted-single-operator.md) for the current model.

## Context

A server GitHub credential can read a private repository that the visitor cannot access.
The app must not put that result in a public bucket.

## Decision in the code

`getPrivateLocation` in `src/server/storage/cache-key.ts:56` selects the private bucket and a namespace from the caller's token.
`persistGenerationResult` in `src/server/storage/generation-persistence.ts:30` does not save a private result without that token.

## Consequences

A visitor with no GitHub token can see a generated private result in the current stream but cannot reopen it from storage.
A visitor with a token can read only the artifact in the namespace of that token.

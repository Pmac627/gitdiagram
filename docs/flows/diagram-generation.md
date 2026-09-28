---
type: Flow
title: Diagram generation
description: How a GitHub repository becomes a validated Mermaid diagram.
diataxis: explanation
status: draft
sources:
  - id: request
    resource: src/app/api/generate/stream/route.ts
  - id: admission
    resource: src/server/generate/request-admission.ts
  - id: github
    resource: src/server/generate/github.ts
  - id: context
    resource: src/server/generate/source-context.ts
  - id: model
    resource: src/server/generate/openai.ts
  - id: browser
    resource: src/features/diagram/**
generated: { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
verified:
  - { by: codex/gpt-6, at: 2026-09-28T19:17:00Z }
tags: [diagram, github, model]
---

# Diagram generation

## Purpose

This flow makes a source-grounded architecture diagram for one GitHub repository.
The browser receives progress and a terminal result through server-sent events.

## Entry points

`Repo` in `src/app/[username]/[repo]/page.tsx` shows saved public state when it is available.
`useDiagram` in `src/hooks/useDiagram.ts` starts or refreshes generation from the browser.
`POST` in `src/app/api/generate/stream/route.ts:126` coordinates the server work.

## Sequence

```mermaid
sequenceDiagram
    actor Visitor
    participant API as Generation route
    participant GitHub
    participant Model
    participant Store as Artifact store
    Visitor->>API: POST generation request
    API->>API: Admit request and reserve limits
    API->>GitHub: Read metadata, tree, README, source
    API->>Model: Send bounded repository context
    Model-->>API: Explanation and graph
    API->>API: Validate graph and compile Mermaid
    API->>Store: Save result and audit
    API-->>Visitor: Progress and terminal event
```

## Key behavior

* `admitGenerationRequest` in `src/server/generate/request-admission.ts:65` checks input, credentials, limits, and cancellation.
* `getGithubData` in `src/server/generate/github.ts:583` reads repository metadata, the file tree, and README.
* `fetchSourceContext` in `src/server/generate/source-context.ts:129` reads bounded source excerpts.
* `createClient` in `src/server/generate/openai.ts:48` selects the model provider.
* `POST` in `src/app/api/generate/stream/route.ts` checks graph paths and makes Mermaid before it sends a terminal event.
* `sanitizeMermaidSourceForRender` and `enforceSafeMermaidLinks` in `src/features/diagram/mermaid-security.ts` let the browser use only GitHub URLs.

## Failure modes

`admitGenerationRequest` sends an error for invalid input or a denied rate limit.
`getGithubData` refuses a private repository without the caller's GitHub token.
The generation route can stop on a deadline, cancellation, model error, graph error, quota denial, or storage error.
A storage failure can keep a result in the current stream without a saved result for the next visit.

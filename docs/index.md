okf_version: "0.2"

# Documentation index

## Catalog

* [Flows](flows/) - End-to-end paths through the app.
* [Decisions](decisions/) - Decisions that the code and its comments support.
* [Operations](operations/) - Caching and crawler behavior.
* [System overview](overview.md) - Purpose, users, and external boundaries of GitDiagram.
* [Application architecture](architecture.md) - Runtime parts, data stores, and the main service boundaries.
* [Configuration inventory](configuration.md) - Environment keys, defaults, and code consumers.
* [Diagram generation](flows/diagram-generation.md) - How a GitHub repository becomes a validated Mermaid diagram.
* [Diagram artifact storage](flows/artifact-storage.md) - How SQLite and local files hold diagram results, locks, and controls.
* [Explainer video](flows/explainer-video.md) - How a repository becomes a stored video and a rendered MP4 file, with no public quotas.
* [Operator dashboard](flows/operator-live-ops.md) - How the operator signs in, pauses new videos, and reads the voice balance on the admin dashboard.
* [Self-hosted single-operator deployment](decisions/0003-self-hosted-single-operator.md) - Accepted. GitDiagram runs for one operator on IIS, with SQLite and local disk, provider adapters, and limited outbound traffic.
* [Private diagram storage](decisions/0001-private-diagram-storage.md) - Superseded. Private diagram results use a token-derived namespace in a private R2 bucket.
* [Video admission on Redis failure](decisions/0002-video-admission-redis.md) - Superseded. Public video generation stopped when quota or operator control state was unavailable.
* [Local development setup](dev-setup.md) - How to prepare and start a local GitDiagram checkout.
* [Deploy to the IIS host](deployment.md) - How to package GitDiagram and run it on SmarterASP.NET with IIS and httpPlatformHandler.
* [Host recovery](deployment-failover.md) - How to restore GitDiagram on the IIS host from a package and a copy of App_Data.
* [Traffic protection](operations/traffic-protection.md) - How repository pages and social images use caches, and how the app keeps crawlers out.
* [Affordable generation benchmark](affordable-generation-benchmarks.md) - Historical generation cost and latency measurements.
* [GPT-6 Luna migration](gpt-6-luna-rollout.md) - Historical model choice and rollout record.
* [Security audit, 2026-09-28](vuln-scan-2026-09-28.md) - Verified security findings and outbound data paths.
* [Security remediation, 2026-09-28](security-remediation-2026-09-28.md) - Actions for a controlled self-hosted deployment.

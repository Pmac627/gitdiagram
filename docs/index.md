okf_version: "0.2"

# Documentation index

## Catalog

* [Flows](flows/) - End-to-end paths through the app.
* [Decisions](decisions/) - Decisions that the code and its comments support.
* [Operations](operations/) - Deployment and traffic behavior.
* [System overview](overview.md) - Purpose, users, and external boundaries of GitDiagram.
* [Application architecture](architecture.md) - Runtime parts, data stores, and the main service boundaries.
* [Configuration inventory](configuration.md) - Environment keys, Worker bindings, defaults, and code consumers.
* [Diagram generation](flows/diagram-generation.md) - How a GitHub repository becomes a validated Mermaid diagram.
* [Diagram artifact storage](flows/artifact-storage.md) - How public and private diagram results are saved and read.
* [Explainer video](flows/explainer-video.md) - How a repository becomes a stored video and a rendered MP4 file.
* [Operator live operations](flows/operator-live-ops.md) - How operator controls and live activity reach the admin dashboard.
* [Sponsor measurement](flows/sponsor-measurement.md) - How sponsor views and clicks are admitted, counted, and sent to analytics.
* [Private diagram storage](decisions/0001-private-diagram-storage.md) - Why private artifacts use a token-derived namespace.
* [Video admission on Redis failure](decisions/0002-video-admission-redis.md) - Why public video generation stops without quota state.
* [Local development setup](dev-setup.md) - How to prepare and start a local GitDiagram checkout.
* [Offline Railway recovery](deployment-failover.md) - How to use the retained Docker and Railway recovery files.
* [Traffic protection](operations/traffic-protection.md) - Limits and controls for public traffic.
* [PostHog usage and replay](operations/posthog.md) - Analytics, session replay, and related privacy controls.
* [Sponsor campaign reporting](operations/sponsor-clicks.md) - Sponsor event capture and report paths.
* [Sponsor placement screenshots](sponsor-preview-images.md) - Local previews of sponsor placements.
* [Affordable generation benchmark](affordable-generation-benchmarks.md) - Historical generation cost and latency measurements.
* [GPT-6 Luna migration](gpt-6-luna-rollout.md) - Historical model choice and rollout record.
* [Security audit, 2026-09-28](vuln-scan-2026-09-28.md) - Verified security findings and outbound data paths.
* [Security remediation, 2026-09-28](security-remediation-2026-09-28.md) - Actions for a controlled self-hosted deployment.

# GitDiagram (private fork)

A private, self-hosted fork of [GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram) by Ahmed Khaleel. It turns a GitHub repository into an interactive architecture diagram, and (for public repositories only) a short narrated video.

It is built for one operator. Every page and API call needs the operator sign-in, private repositories work, and nothing is shared. Data leaves the host only for GitHub and the AI provider you configure. Videos are made only for public repositories.

Credit and license: the upstream project is MIT licensed, and this fork keeps the [LICENSE](LICENSE) file as it is.

## Quick start

```bash
bun install
cp .env.example .env   # set DATA_DIR, OPERATOR_TOKEN (40+ characters) and the AI_* values
bun run dev
```

Open http://localhost:3000 and sign in with `OPERATOR_TOKEN`. A local OpenAI-compatible server such as LM Studio works through `AI_BASE_URL`.

## Documentation

- Developer docs: `docs/`.
- Deployment guide: `docs/deployment.md` (coming with step 32).

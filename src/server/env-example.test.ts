import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

// Platform keys the runtime or Next.js sets. Code reads them, but an
// operator never writes them in .env.example, so they need no entry.
const PLATFORM_KEYS = new Set(["NODE_ENV", "PORT", "HOSTNAME", "NEXT_PHASE"]);

const REQUIRED_KEYS = [
  "DATA_DIR",
  "OPERATOR_TOKEN",
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_API_KEY",
  "SSE_FLUSH_PAD_BYTES",
  "VIDEO_RENDER_ENABLED",
];

const REMOVED_PREFIXES = [
  "UPSTASH_",
  "R2_",
  "POSTHOG",
  "NEXT_PUBLIC_POSTHOG",
  "PRESENCE",
  "NEXT_PUBLIC_PRESENCE",
  "SPONSOR",
  "VERCEL",
  "RAILWAY",
  "ANTHROPIC_ADMIN",
];

const example = readFileSync(path.join(root, ".env.example"), "utf8");

function documentedKeys(): string[] {
  const keys = new Set<string>();

  for (const line of example.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);

    if (match?.[1]) {
      keys.add(match[1]);
    }
  }

  return [...keys];
}

function sourceText(): string {
  const parts: string[] = [
    readFileSync(path.join(root, "next.config.js"), "utf8"),
  ];

  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);

      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      const relative = path.relative(root, full).split(path.sep).join("/");

      if (
        /\.(ts|tsx|js|mjs)$/.test(name) &&
        !/\.test\.[cm]?[jt]sx?$/.test(relative)
      ) {
        parts.push(readFileSync(full, "utf8"));
      }
    }
  };

  walk(path.join(root, "src"));

  return parts.join("\n");
}

describe(".env.example", () => {
  const keys = documentedKeys();

  it("lists every required fork key", () => {
    expect(REQUIRED_KEYS.filter((key) => !keys.includes(key))).toEqual([]);
  });

  it("documents only keys that non-test source or next.config.js reads", () => {
    const text = sourceText();
    const unread = keys.filter(
      (key) =>
        !PLATFORM_KEYS.has(key) && !new RegExp(`\\b${key}\\b`).test(text),
    );

    expect(unread).toEqual([]);
  });

  it("lists no key from a removed service or platform", () => {
    expect(
      keys.filter((key) =>
        REMOVED_PREFIXES.some((prefix) => key.startsWith(prefix)),
      ),
    ).toEqual([]);
  });

  it("explains that the IIS host needs SSE_FLUSH_PAD_BYTES=9216", () => {
    const lines = example.split(/\r?\n/);
    const index = lines.findIndex((line) =>
      /^#?\s*SSE_FLUSH_PAD_BYTES=/.test(line),
    );

    expect(index).toBeGreaterThan(-1);

    const context = lines.slice(Math.max(0, index - 4), index + 1).join("\n");

    expect(context).toMatch(/IIS/);
    expect(context).toContain("9216");
  });

  it("holds no secret value", () => {
    for (const key of ["OPERATOR_TOKEN", "AI_API_KEY", "CACHE_KEY_SECRET"]) {
      const match = new RegExp(`^${key}=(.*)$`, "m").exec(example);

      expect(match?.[1]?.trim() ?? "").toBe("");
    }
  });
});

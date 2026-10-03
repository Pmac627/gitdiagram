import { pathToFileURL } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

async function loadCatchAllPolicy(): Promise<string> {
  vi.resetModules();

  const configUrl = pathToFileURL(
    path.resolve(__dirname, "../../next.config.js"),
  ).href;
  const config = (await import(
    /* @vite-ignore */ `${configUrl}?t=${Date.now()}`
  )) as {
    default: { headers: () => Promise<HeaderRule[]> };
  };
  const rules = await config.default.headers();
  const rule = rules.find((candidate) => candidate.source === "/:path*");
  const policy = rule?.headers.find(
    (header) => header.key === "Content-Security-Policy",
  )?.value;

  expect(policy).toBeTypeOf("string");

  return policy as string;
}

function directive(policy: string, name: string): string | undefined {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe("next.config.js content security policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("limits connect-src to 'self'", async () => {
    vi.stubEnv("NEXT_PUBLIC_PRESENCE_URL", "");

    const policy = await loadCatchAllPolicy();

    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
  });

  it("ignores NEXT_PUBLIC_PRESENCE_URL: no ws or wss origin in connect-src", async () => {
    vi.stubEnv("NEXT_PUBLIC_PRESENCE_URL", "wss://presence.example.com");

    const policy = await loadCatchAllPolicy();

    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
    expect(policy).not.toContain("presence.example.com");
  });
});

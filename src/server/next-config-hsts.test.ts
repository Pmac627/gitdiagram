import { pathToFileURL } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

async function loadRules(nodeEnv: string): Promise<HeaderRule[]> {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);

  const configUrl = pathToFileURL(
    path.resolve(__dirname, "../../next.config.js"),
  ).href;
  const config = (await import(
    /* @vite-ignore */ `${configUrl}?t=${Date.now()}`
  )) as { default: { headers: () => Promise<HeaderRule[]> } };

  return config.default.headers();
}

function hstsValues(rules: HeaderRule[]): string[] {
  return rules
    .filter((rule) => rule.source === "/:path*")
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key === "Strict-Transport-Security")
    .map((header) => header.value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// Step 16b: the host's panel redirects http to https; HSTS makes browsers
// skip the http request entirely. includeSubDomains is safe here: HSTS from
// gitdiagram.tuple.pro covers only that host and names below it, never the
// parent domain. Browsers ignore HSTS on plain-http localhost, so development
// needs no exception.
describe("next.config.js Strict-Transport-Security", () => {
  it("sends one HSTS header on every path in production", async () => {
    const values = hstsValues(await loadRules("production"));

    expect(values).toHaveLength(1);
  });

  it("asks browsers to remember https for at least a year", async () => {
    const [value] = hstsValues(await loadRules("production"));
    const maxAge = Number(/max-age=(\d+)/i.exec(value ?? "")?.[1] ?? 0);

    expect(maxAge).toBeGreaterThanOrEqual(31536000);
  });
});

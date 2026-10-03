import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("robots.txt for a private tool", () => {
  it("disallows everything for every user agent", async () => {
    const result = await robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];

    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      const agents = Array.isArray(rule.userAgent)
        ? rule.userAgent
        : [rule.userAgent];
      const disallow = Array.isArray(rule.disallow)
        ? rule.disallow
        : [rule.disallow];

      expect(agents).toContain("*");
      expect(disallow).toContain("/");
    }
  });

  it("allows nothing, so no path is reopened", async () => {
    const result = await robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];

    for (const rule of rules) {
      const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow];

      expect(allow.filter(Boolean)).toEqual([]);
    }
  });

  it("does not reference a sitemap", async () => {
    expect(Object.keys(await robots())).not.toContain("sitemap");
    expect((await robots()).sitemap).toBeUndefined();
  });

  it("has no sitemap route file, because the sitemap is off", () => {
    expect(existsSync(path.resolve(__dirname, "sitemap.ts"))).toBe(false);
  });
});

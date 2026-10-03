// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: null as null | { headers?: Record<string, string> },
}));

vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(
      _element: unknown,
      options: { headers?: Record<string, string> },
    ) {
      captured.options = options;
    }
  },
}));

import { createRepoSocialImage } from "./cards";

// The whole site sits behind the operator login, so a social image must never
// be kept by a shared cache (Cloudflare or a browser cache shared by profile).
describe("repository social image cache headers", () => {
  it("is private, and never public or s-maxage", async () => {
    await createRepoSocialImage({
      username: "acme",
      repo: "demo",
      defaultBranch: "main",
      language: "TypeScript",
      stargazerCount: 1,
      isPrivate: false,
    } as Parameters<typeof createRepoSocialImage>[0]);

    const cacheControl = captured.options?.headers?.["Cache-Control"] ?? "";

    expect(cacheControl).not.toMatch(/\bpublic\b/);
    expect(cacheControl).not.toContain("s-maxage");
    expect(cacheControl).toMatch(/private|no-store/);
  });
});

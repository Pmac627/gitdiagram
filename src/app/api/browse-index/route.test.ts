// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { registerOperatorSession } from "~/server/auth/test-session";

const session = registerOperatorSession();

const mocks = vi.hoisted(() => ({ getCachedBrowsePage: vi.fn() }));

vi.mock("~/server/browse-index-cache", () => ({
  getCachedBrowsePage: mocks.getCachedBrowsePage,
}));

import { GET } from "./route";

const get = () =>
  GET(
    new Request("https://gitdiagram.com/api/browse-index?q=x", {
      headers: session.headers,
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/browse-index", () => {
  it("is never kept by a shared cache (private or no-store only)", async () => {
    mocks.getCachedBrowsePage.mockResolvedValue({ entries: [], total: 0 });

    const response = await get();
    const cacheControl = response.headers.get("cache-control") ?? "";

    expect(response.status).toBe(200);
    expect(cacheControl).not.toMatch(/\bpublic\b/);
    expect(cacheControl).not.toContain("s-maxage");
    expect(cacheControl).toMatch(/private|no-store/);
  });

  it("does not cache an unavailable index", async () => {
    mocks.getCachedBrowsePage.mockResolvedValue(null);

    const response = await get();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

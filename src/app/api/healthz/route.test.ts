// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { checkReadiness } = vi.hoisted(() => ({
  checkReadiness: vi.fn(),
}));

vi.mock("~/server/readiness", () => ({
  checkReadiness,
}));

import { registerOperatorSession } from "~/server/auth/test-session";
import { ADMIN_SESSION_COOKIE } from "~/server/auth/operator";

import { GET } from "./route";

// /api/healthz is exempt from the operator gate (see proxy.ts), so it must
// answer anonymous callers with almost nothing: ok or not ok, no detail.

const session = registerOperatorSession();

const READY = {
  ok: true,
  checks: {
    configuration: true,
    provider: true,
    database: true,
    dataDir: true,
  },
};

const NOT_READY = {
  ok: false,
  checks: {
    configuration: true,
    provider: true,
    database: true,
    dataDir: false,
  },
};

function anonymous(): Request {
  return new Request("https://gitdiagram.com/api/healthz");
}

function signedIn(): Request {
  return new Request("https://gitdiagram.com/api/healthz", {
    headers: session.headers,
  });
}

describe("GET /api/healthz, anonymous", () => {
  beforeEach(() => {
    checkReadiness.mockReset();
  });

  it("returns 200 with exactly {ok: true} when ready", async () => {
    checkReadiness.mockResolvedValue(READY);

    const response = await GET(anonymous());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns 503 with exactly {ok: false} when a dependency is unavailable, without checks", async () => {
    checkReadiness.mockResolvedValue(NOT_READY);

    const response = await GET(anonymous());

    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toEqual({ ok: false });
    expect(body).not.toHaveProperty("checks");
  });

  it("is never cached", async () => {
    checkReadiness.mockResolvedValue(READY);

    expect((await GET(anonymous())).headers.get("cache-control")).toBe(
      "no-store",
    );

    checkReadiness.mockResolvedValue(NOT_READY);

    expect((await GET(anonymous())).headers.get("cache-control")).toBe(
      "no-store",
    );
  });

  it("treats a forged or garbage session cookie as anonymous", async () => {
    checkReadiness.mockResolvedValue(NOT_READY);

    for (const cookie of [
      `${ADMIN_SESSION_COOKIE}=v3.9999999999999.0.forged`,
      `${ADMIN_SESSION_COOKIE}=garbage`,
    ]) {
      const response = await GET(
        new Request("https://gitdiagram.com/api/healthz", {
          headers: { cookie },
        }),
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(body, cookie).toEqual({ ok: false });
    }
  });

  it("ignores a Bearer token: only a session cookie unlocks the detail", async () => {
    checkReadiness.mockResolvedValue(READY);

    const response = await GET(
      new Request("https://gitdiagram.com/api/healthz", {
        headers: { authorization: `Bearer ${"o".repeat(48)}` },
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not leak paths or environment values", async () => {
    process.env.CACHE_KEY_SECRET = "super-secret-cache-key-value-xyz";
    checkReadiness.mockResolvedValue(NOT_READY);

    for (const readiness of [READY, NOT_READY]) {
      checkReadiness.mockResolvedValue(readiness);

      const text = await (await GET(anonymous())).text();

      expect(text).not.toContain(process.env.DATA_DIR ?? "\u0000");
      expect(text).not.toContain("super-secret-cache-key-value-xyz");
      expect(text).not.toMatch(/[\\/]/);
    }

    delete process.env.CACHE_KEY_SECRET;
  });
});

describe("GET /api/healthz, signed in", () => {
  beforeEach(() => {
    checkReadiness.mockReset();
  });

  it("adds the four checks to a ready answer", async () => {
    checkReadiness.mockResolvedValue(READY);

    const response = await GET(signedIn());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checks: {
        configuration: true,
        provider: true,
        database: true,
        dataDir: true,
      },
    });
  });

  it("adds the checks to a 503 answer and shows which one failed", async () => {
    checkReadiness.mockResolvedValue(NOT_READY);

    const response = await GET(signedIn());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: { dataDir: false },
    });
  });

  it("still does not leak paths or environment values", async () => {
    process.env.CACHE_KEY_SECRET = "super-secret-cache-key-value-xyz";
    checkReadiness.mockResolvedValue(NOT_READY);

    const text = await (await GET(signedIn())).text();

    expect(text).not.toContain(process.env.DATA_DIR ?? "\u0000");
    expect(text).not.toContain("super-secret-cache-key-value-xyz");
    expect(text).not.toMatch(/[\\/]/);

    delete process.env.CACHE_KEY_SECRET;
  });
});

// @vitest-environment node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

vi.mock("server-only", () => ({}));

import { config, proxy } from "~/proxy";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  revokeAdminSessions,
} from "~/server/auth/operator";
import { checkSignIn } from "~/server/auth/sign-in-guard";
import { closeDb } from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

// The proxy is the operator gate: every page and API route needs a signed-in
// session cookie. A Bearer token is not accepted (the Professor, 2026-09-30).
// The proxy runs on the Node.js runtime, so it verifies the session fully,
// including the session generation in SQLite.

const TOKEN = "a".repeat(40);
const ORIGIN = "https://gitdiagram.com";
const originalEnv = { ...process.env };

let dataDir: TempDataDir;
let cookie: string;

beforeEach(async () => {
  process.env = { ...originalEnv, OPERATOR_TOKEN: TOKEN };
  delete process.env.VIDEO_ADMIN_TOKEN;
  dataDir = await createTempDataDir();
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession())!.value}`;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

function get(pathAndQuery: string, headers: HeadersInit = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${pathAndQuery}`, { headers });
}

function signedIn(pathAndQuery: string): NextRequest {
  return get(pathAndQuery, { cookie });
}

function passesThrough(response: Response): boolean {
  return (
    response.status === 200 && response.headers.get("x-middleware-next") === "1"
  );
}

function redirectTarget(response: Response): URL {
  return new URL(response.headers.get("location")!);
}

describe("Server Action rejection", () => {
  it("rejects forged Server Action requests without caching the response", async () => {
    for (const headers of [
      { "Next-Action": "x" },
      { "Next-Action": "x", cookie },
    ]) {
      const response = await proxy(
        new NextRequest(`${ORIGIN}/`, {
          method: "POST",
          headers: new Headers(
            Object.entries(headers).filter(
              ([, value]) => value !== undefined,
            ) as [string, string][],
          ),
        }),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("signed out: pages", () => {
  it("redirects a page to /sign-in with the path and query in next", async () => {
    const response = await proxy(get("/acme/demo?utm_source=x&y=1"));

    expect(response.status).toBe(307);

    const target = redirectTarget(response);

    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/sign-in");
    expect(target.searchParams.get("next")).toBe("/acme/demo?utm_source=x&y=1");
  });

  it("redirects the home page and /admin", async () => {
    const home = await proxy(get("/"));
    const admin = await proxy(get("/admin"));

    expect(home.status).toBe(307);
    expect(redirectTarget(home).pathname).toBe("/sign-in");
    expect([null, "/"]).toContain(
      redirectTarget(home).searchParams.get("next"),
    );
    expect(admin.status).toBe(307);
    expect(redirectTarget(admin).searchParams.get("next")).toBe("/admin");
  });

  it("gates the gallery, reels, the watch page and the poster before any normalization", async () => {
    for (const url of [
      "/videos",
      "/reels",
      "/browse",
      "/acme/demo/video",
      "/Acme/Demo",
      "/Acme/Demo/opengraph-image",
    ]) {
      const response = await proxy(get(url));

      expect(response.status, url).toBe(307);
      expect(redirectTarget(response).pathname, url).toBe("/sign-in");
    }
  });

  it.each([
    ["//evil.com", "//evil.com/x"],
    ["//evil.com/path", "//evil.com/path"],
    ["backslash host", "/\\evil.com"],
  ])("drops an unsafe next value: %s", async (_name, pathAndQuery) => {
    const response = await proxy(get(pathAndQuery));

    expect(response.status).toBe(307);

    const target = redirectTarget(response);

    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/sign-in");
    expect([null, "/"]).toContain(target.searchParams.get("next"));
    expect(target.href).not.toMatch(/evil/);
  });

  it("does not let a forged cookie, an expired session or a wrong Bearer through", async () => {
    for (const headers of [
      { cookie: `${ADMIN_SESSION_COOKIE}=v2.9999999999999.0.forged` },
      { cookie: `${ADMIN_SESSION_COOKIE}=garbage` },
      { cookie: "theme=dark" },
      { authorization: `Bearer ${TOKEN}` }, // a Bearer is for the API, not pages
    ]) {
      const response = await proxy(
        get(
          "/acme/demo",
          new Headers(
            Object.entries(headers).filter(
              ([, value]) => value !== undefined,
            ) as [string, string][],
          ),
        ),
      );

      expect(response.status, JSON.stringify(headers)).toBe(307);
    }
  });
});

describe("signed out: API", () => {
  it("answers /api/* with a 401 JSON error that is never cached", async () => {
    for (const url of [
      "/api/generate/stream",
      "/api/generate/cost",
      "/api/generate/cancel",
      "/api/credentials",
      "/api/diagram-state",
      "/api/video",
      "/api/video/generate",
      "/api/video/render",
      "/api/video/file?username=a&repo=b",
      "/api/video/audio",
      "/api/video/catalog",
      "/api/admin/state",
      "/api/diagram-preview",
      "/api/browse-index",
    ]) {
      const response = await proxy(get(url));

      expect(response.status, url).toBe(401);
      expect(response.headers.get("content-type"), url).toMatch(/json/);
      expect(response.headers.get("cache-control"), url).toBe("no-store");
      expect(response.headers.get("location"), url).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: expect.any(String) as string,
      });
    }
  });

  it("answers a signed-out POST with 401, not a redirect", async () => {
    const response = await proxy(
      new NextRequest(`${ORIGIN}/api/generate/stream`, { method: "POST" }),
    );

    expect(response.status).toBe(401);
  });

  it("refuses the operator token as a Bearer: cookie sessions are the only way in", async () => {
    const good = await proxy(
      get("/api/video/generate", { authorization: `Bearer ${TOKEN}` }),
    );
    const bad = await proxy(
      get("/api/video/generate", { authorization: `Bearer ${TOKEN}x` }),
    );

    expect(good.status).toBe(401);
    expect(passesThrough(good)).toBe(false);
    expect(bad.status).toBe(401);
  });

  it("ignores a Bearer header: it does not count toward the sign-in throttle", async () => {
    for (let attempt = 0; attempt < 15; attempt++) {
      await proxy(get("/api/video", { authorization: "Bearer wrong" }));
    }

    // A correct sign-in is still allowed, so the failures were never counted.
    expect((await checkSignIn(get("/api/auth/session"), true)).blocked).toBe(
      false,
    );
  });

  it("leaves the render segment route to its own HMAC check", async () => {
    const response = await proxy(
      new NextRequest(`${ORIGIN}/api/video/render/segment`, { method: "POST" }),
    );

    expect(passesThrough(response)).toBe(true);
  });
});

describe("signed in", () => {
  it("lets pages and API calls through", async () => {
    for (const url of [
      "/",
      "/acme/demo",
      "/acme/demo?utm=1",
      "/videos",
      "/admin",
      "/api/generate/stream",
      "/api/video?username=a&repo=b",
    ]) {
      const response = await proxy(signedIn(url));

      expect(passesThrough(response), url).toBe(true);
    }
  });

  it("still preserves campaign parameters when canonicalizing repository URLs", async () => {
    const response = await proxy(signedIn("/Acme/Demo?utm_source=GitHub"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/acme/demo?utm_source=GitHub`,
    );
  });
});

describe("session checks", () => {
  it("treats a session signed out everywhere as signed out", async () => {
    expect(passesThrough(await proxy(signedIn("/acme/demo")))).toBe(true);

    await revokeAdminSessions();

    const page = await proxy(signedIn("/acme/demo"));
    const api = await proxy(signedIn("/api/video"));

    expect(page.status).toBe(307);
    expect(redirectTarget(page).pathname).toBe("/sign-in");
    expect(api.status).toBe(401);
  });

  it("treats an expired session as signed out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 86_400_000);

    expect((await proxy(signedIn("/acme/demo"))).status).toBe(307);
    expect((await proxy(signedIn("/api/video"))).status).toBe(401);
  });

  it("fails closed when the session store cannot be read", async () => {
    closeDb();

    const file = path.join(dataDir.path, "not-a-directory");

    writeFileSync(file, "x");
    process.env.DATA_DIR = path.join(file, "data");

    expect((await proxy(signedIn("/acme/demo"))).status).toBe(307);
    expect((await proxy(signedIn("/api/video"))).status).toBe(401);
  });

  it("fails closed when DATA_DIR is unset", async () => {
    closeDb();
    delete process.env.DATA_DIR;

    expect((await proxy(signedIn("/"))).status).toBe(307);
    expect((await proxy(signedIn("/api/video"))).status).toBe(401);
  });

  it("refuses everything when no operator token is configured", async () => {
    delete process.env.OPERATOR_TOKEN;

    expect((await proxy(signedIn("/"))).status).toBe(307);
    expect((await proxy(signedIn("/api/video"))).status).toBe(401);
    expect(
      (await proxy(get("/api/video", { authorization: `Bearer ${TOKEN}` })))
        .status,
    ).toBe(401);
  });
});

// The matcher replaces the old "mixed-case repository URL only" matcher (the
// proxy now runs for every path except static assets and the sign-in flow),
// so the old per-path expectations are rewritten here.
describe("matcher", () => {
  it.each([
    "/",
    "/acme/demo",
    "/Acme/Demo",
    "/Acme/Demo/opengraph-image",
    "/acme/demo/video",
    "/browse",
    "/videos",
    "/reels",
    "/admin",
    "/api/generate/stream",
    "/api/diagram-state",
    "/api/video/render",
    "/api/video/file",
    "/api/admin/state",
  ])("runs the gate for %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each([
    "/_next/static/chunks/ABC.js",
    "/_next/static/css/app.css",
    "/_next/image",
    "/favicon.ico",
    "/video-engine/kit.js",
    "/video-engine/stage.html",
    "/video-engine/assets/vendor/gsap.min.js",
    "/sign-in",
    "/api/auth/session",
    "/api/healthz",
  ])("skips the gate for %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });

  it("exempts exactly /api/healthz and nothing that only looks like it", () => {
    for (const url of [
      "/api/healthzz",
      "/api/healthz/x",
      "/api/healthz2",
      "/api/health",
      "/x/api/healthz",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    }
  });

  it("does not exempt look-alike paths", () => {
    for (const url of [
      "/sign-in-now",
      "/api/authors",
      "/api/auth-bypass",
      "/video-engines",
      "/acme/video-engine/x.js",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    }
  });

  it("still matches forged actions on any path", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "/api/generate/stream",
        headers: { "next-action": "x" },
      }),
    ).toBe(true);
  });
});

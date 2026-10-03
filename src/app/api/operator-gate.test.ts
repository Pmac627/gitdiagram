// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as adminState } from "~/app/api/admin/state/route";
import { POST as credentials } from "~/app/api/credentials/route";
import { POST as diagramState } from "~/app/api/diagram-state/route";
import { POST as generateCancel } from "~/app/api/generate/cancel/route";
import { POST as generateCost } from "~/app/api/generate/cost/route";
import { POST as generateStream } from "~/app/api/generate/stream/route";
import { GET as videoStatus } from "~/app/api/video/route";
import { GET as videoAudio } from "~/app/api/video/audio/route";
import { GET as videoCatalog } from "~/app/api/video/catalog/route";
import { GET as videoFile } from "~/app/api/video/file/route";
import { POST as videoGenerate } from "~/app/api/video/generate/route";
import { POST as videoRender } from "~/app/api/video/render/route";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  revokeAdminSessions,
} from "~/server/auth/operator";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

// Defense in depth: the proxy gates every route, but unit tests bypass it and
// a matcher mistake must not open a sensitive route. Each handler therefore
// checks the operator itself, before it reads the body, spends money or
// touches storage. These calls are same-origin and well-formed, so the only
// thing wrong with them is the missing session.

type Handler = (request: Request) => Promise<Response> | Response;

const TOKEN = "a".repeat(40);
const ORIGIN = "https://gitdiagram.com";
const originalEnv = { ...process.env };

const ROUTES: Array<{
  name: string;
  handler: Handler;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}> = [
  {
    name: "POST /api/generate/stream",
    handler: generateStream,
    method: "POST",
    path: "/api/generate/stream",
    body: { username: "acme", repo: "demo" },
  },
  {
    name: "POST /api/generate/cost",
    handler: generateCost,
    method: "POST",
    path: "/api/generate/cost",
    body: { username: "acme", repo: "demo" },
  },
  {
    name: "POST /api/generate/cancel",
    handler: generateCancel,
    method: "POST",
    path: "/api/generate/cancel",
    body: { username: "acme", repo: "demo", sessionId: "s" },
  },
  {
    name: "POST /api/credentials",
    handler: credentials,
    method: "POST",
    path: "/api/credentials",
    body: { action: "status" },
  },
  {
    name: "POST /api/diagram-state",
    handler: diagramState,
    method: "POST",
    path: "/api/diagram-state",
    body: { username: "acme", repo: "demo" },
  },
  {
    name: "GET /api/video",
    handler: videoStatus,
    method: "GET",
    path: "/api/video?username=acme&repo=demo",
  },
  {
    name: "POST /api/video/generate",
    handler: videoGenerate,
    method: "POST",
    path: "/api/video/generate",
    body: { username: "acme", repo: "demo" },
  },
  {
    name: "POST /api/video/render",
    handler: videoRender,
    method: "POST",
    path: "/api/video/render",
    body: { username: "acme", repo: "demo", format: "landscape" },
  },
  {
    name: "GET /api/video/file",
    handler: videoFile,
    method: "GET",
    path: "/api/video/file?username=acme&repo=demo&format=poster",
  },
  {
    name: "GET /api/video/audio",
    handler: videoAudio,
    method: "GET",
    path: "/api/video/audio?username=acme&repo=demo&v=x&clip=1",
  },
  {
    name: "GET /api/video/catalog",
    handler: videoCatalog,
    method: "GET",
    path: "/api/video/catalog",
  },
  {
    name: "GET /api/admin/state",
    handler: adminState,
    method: "GET",
    path: "/api/admin/state",
  },
];

function build(
  route: (typeof ROUTES)[number],
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${route.path}`, {
    method: route.method,
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
}

let dataDir: TempDataDir;

beforeEach(async () => {
  process.env = { ...originalEnv, OPERATOR_TOKEN: TOKEN };
  delete process.env.VIDEO_ADMIN_TOKEN;
  dataDir = await createTempDataDir();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

describe("sensitive route handlers refuse callers without a session", () => {
  it.each(ROUTES)("$name answers 401 with no credentials", async (route) => {
    const response = await route.handler(build(route));

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.any(String) as string,
    });
  });

  it.each(ROUTES)(
    "$name answers 401 to a forged session cookie",
    async (route) => {
      const response = await route.handler(
        build(route, {
          cookie: `${ADMIN_SESSION_COOKIE}=v2.9999999999999.0.forged`,
        }),
      );

      expect(response.status).toBe(401);
    },
  );

  it.each(ROUTES)(
    "$name answers 401 to a wrong Bearer token",
    async (route) => {
      const response = await route.handler(
        build(route, { authorization: `Bearer ${TOKEN}x` }),
      );

      expect(response.status).toBe(401);
    },
  );

  it.each(ROUTES)(
    "$name answers 401 to the correct operator token as a Bearer",
    async (route) => {
      const response = await route.handler(
        build(route, { authorization: `Bearer ${TOKEN}` }),
      );

      expect(response.status).toBe(401);
    },
  );

  it.each(ROUTES)(
    "$name answers 401 to a session signed out everywhere",
    async (route) => {
      const session = (await createAdminSession())!;

      await revokeAdminSessions();

      const response = await route.handler(
        build(route, { cookie: `${ADMIN_SESSION_COOKIE}=${session.value}` }),
      );

      expect(response.status).toBe(401);
    },
  );

  it.each(ROUTES)(
    "$name answers 401 for every caller when no operator token is configured",
    async (route) => {
      const session = (await createAdminSession())!;

      delete process.env.OPERATOR_TOKEN;

      const response = await route.handler(
        build(route, {
          cookie: `${ADMIN_SESSION_COOKIE}=${session.value}`,
          authorization: `Bearer ${TOKEN}`,
        }),
      );

      expect([401, 503]).toContain(response.status);
    },
  );
});

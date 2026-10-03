import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  revokeAdminSessions,
} from "./operator";
import { requireOperator } from "./require-operator";
import { checkSignIn } from "./sign-in-guard";

const TOKEN = "a".repeat(40);
const originalEnv = { ...process.env };

let dataDir: TempDataDir;

function request(headers: HeadersInit = {}): Request {
  return new Request("https://gitdiagram.com/api/generate/stream", {
    method: "POST",
    headers,
  });
}

async function sessionCookie(): Promise<string> {
  return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession())!.value}`;
}

beforeEach(async () => {
  process.env = { ...originalEnv, OPERATOR_TOKEN: TOKEN };
  delete process.env.VIDEO_ADMIN_TOKEN;
  dataDir = await createTempDataDir();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

describe("requireOperator", () => {
  it("returns null for a valid session cookie", async () => {
    expect(
      await requireOperator(request({ cookie: await sessionCookie() })),
    ).toBeNull();
  });

  it("refuses the correct operator token as a Bearer (no Bearer access)", async () => {
    const response = await requireOperator(
      request({ authorization: `Bearer ${TOKEN}` }),
    );

    expect(response?.status).toBe(401);
  });

  it("does not count a Bearer header toward the sign-in throttle", async () => {
    for (let attempt = 0; attempt < 15; attempt++) {
      await requireOperator(request({ authorization: "Bearer wrong" }));
    }

    expect((await checkSignIn(request(), true)).blocked).toBe(false);
  });

  it("returns a 401 JSON error, never cached, when there is no credential", async () => {
    const response = await requireOperator(request());

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(response!.headers.get("content-type")).toMatch(/json/);
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(response!.headers.get("set-cookie")).toBeNull();
    await expect(response!.json()).resolves.toEqual({
      error: expect.any(String) as string,
    });
  });

  it("refuses a wrong Bearer, a malformed Authorization header and a forged cookie", async () => {
    for (const headers of [
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: "Bearer " },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
      { cookie: `${ADMIN_SESSION_COOKIE}=v2.9999999999999.0.forged` },
      { cookie: "other=1" },
    ]) {
      const response = await requireOperator(
        request(
          new Headers(
            Object.entries(headers).filter(
              ([, value]) => value !== undefined,
            ) as [string, string][],
          ),
        ),
      );

      expect(response?.status, JSON.stringify(headers)).toBe(401);
    }
  });

  it("refuses a session that was signed out everywhere", async () => {
    const cookie = await sessionCookie();

    expect(await requireOperator(request({ cookie }))).toBeNull();

    await revokeAdminSessions();

    expect((await requireOperator(request({ cookie })))?.status).toBe(401);
  });

  it("keeps a valid cookie working while the sign-in guard is blocked", async () => {
    const cookie = await sessionCookie();

    for (let attempt = 0; attempt < 11; attempt++) {
      await checkSignIn(request(), false);
    }

    expect(await requireOperator(request({ cookie }))).toBeNull();
  });

  it("refuses every request when no operator token is configured (fail closed)", async () => {
    const cookie = await sessionCookie();

    delete process.env.OPERATOR_TOKEN;

    for (const headers of [
      {},
      { cookie },
      { authorization: `Bearer ${TOKEN}` },
      { authorization: "Bearer " },
    ]) {
      const response = await requireOperator(
        request(
          new Headers(
            Object.entries(headers).filter(
              ([, value]) => value !== undefined,
            ) as [string, string][],
          ),
        ),
      );

      expect(response, JSON.stringify(headers)).not.toBeNull();
      expect([401, 503]).toContain(response!.status);
    }
  });

  it("accepts a session for the VIDEO_ADMIN_TOKEN fallback, but not its Bearer", async () => {
    delete process.env.OPERATOR_TOKEN;
    process.env.VIDEO_ADMIN_TOKEN = "d".repeat(40);

    expect(
      (
        await requireOperator(
          request({ authorization: `Bearer ${"d".repeat(40)}` }),
        )
      )?.status,
    ).toBe(401);
    expect(
      await requireOperator(request({ cookie: await sessionCookie() })),
    ).toBeNull();
  });
});

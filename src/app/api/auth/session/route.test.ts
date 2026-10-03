import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verifyAdminSession } from "~/server/auth/operator";
import { closeDb } from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

import { DELETE, GET, POST } from "./route";

// /api/auth/session is the sign-in API. The proxy leaves /api/auth/* open, so
// this route does its own same-origin check and token guard. It replaces
// /api/admin/session: the proxy exemption is the reason it lives under
// /api/auth (one exempt prefix, and nothing else under /api/admin is open).

const TOKEN = "a".repeat(40);
const originalEnv = { ...process.env };

let dataDir: TempDataDir;

beforeEach(async () => {
  process.env = { ...originalEnv, OPERATOR_TOKEN: TOKEN };
  delete process.env.VIDEO_ADMIN_TOKEN;
  dataDir = await createTempDataDir();
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

function signIn(
  token: string,
  headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9" },
) {
  return POST(
    new Request("https://gitdiagram.com/api/auth/session", {
      method: "POST",
      headers: {
        origin: "https://gitdiagram.com",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ token }),
    }),
  );
}

/** Runs a request whose failure path waits, without waiting for real. */
async function settle(response: Promise<Response>): Promise<Response> {
  await vi.runAllTimersAsync();

  return response;
}

const sessionCookie = (response: Response) =>
  response.headers.get("set-cookie")!.split(";")[0]!;

const cookieValue = (response: Response) =>
  sessionCookie(response).split("=").slice(1).join("=");

describe("POST /api/auth/session", () => {
  it("signs in with the operator token and sets a hardened cookie", async () => {
    const response = await signIn(TOKEN);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");

    const setCookie = response.headers.get("set-cookie")!;

    expect(setCookie).toMatch(/^gd_admin=v3\./);
    expect(setCookie).toMatch(/;\s*Path=\/(;|$)/);
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Strict/i);
    expect(setCookie).toMatch(/;\s*Max-Age=2592000/);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).not.toContain(TOKEN);
    expect(await verifyAdminSession(cookieValue(response))).toBe(true);
  });

  it("marks the cookie Secure and __Host- prefixed in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const production = await import("./route");
    const response = await production.POST(
      new Request("https://gitdiagram.com/api/auth/session", {
        method: "POST",
        headers: {
          origin: "https://gitdiagram.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-gd_admin=/);
    expect(response.headers.get("set-cookie")).toMatch(/;\s*Secure/i);
    expect(response.headers.get("set-cookie")).toMatch(/;\s*HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/;\s*SameSite=Strict/i);

    // resetModules opened a separate SQLite module instance. Close it before
    // the test helper removes DATA_DIR on Windows.
    const { closeDb: closeProductionDb } = await import("~/server/storage/db");
    closeProductionDb();
  });

  it("answers 401 to a wrong token and sets no cookie", async () => {
    const response = await settle(signIn("wrong"));

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(((await response.json()) as { error: string }).error).toMatch(
      /not right/i,
    );
  });

  it("says the site is not set up when no token is configured or it is too short", async () => {
    for (const setup of [
      () => delete process.env.OPERATOR_TOKEN,
      () => {
        process.env.OPERATOR_TOKEN = "short";
      },
    ]) {
      setup();

      const response = await signIn("short");

      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(((await response.json()) as { error: string }).error).toMatch(
        /OPERATOR_TOKEN/,
      );
    }
  });

  it("accepts the VIDEO_ADMIN_TOKEN fallback", async () => {
    delete process.env.OPERATOR_TOKEN;
    process.env.VIDEO_ADMIN_TOKEN = "b".repeat(40);

    expect((await signIn("b".repeat(40))).status).toBe(200);
  });

  it("refuses a cross-origin sign-in", async () => {
    const response = await POST(
      new Request("https://gitdiagram.com/api/auth/session", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects malformed bodies", async () => {
    const response = await POST(
      new Request("https://gitdiagram.com/api/auth/session", {
        method: "POST",
        headers: {
          origin: "https://gitdiagram.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: TOKEN, extra: 1 }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("locks out after ten wrong tokens, and refuses even the right one", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await settle(signIn("wrong"))).status).toBe(401);
    }

    const blocked = await signIn(TOKEN);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  it("cannot be side-stepped with forged forwarding headers", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (
          await settle(
            signIn("wrong", { "x-forwarded-for": `198.51.100.${attempt + 1}` }),
          )
        ).status,
      ).toBe(401);
    }

    const forged = await signIn(TOKEN, {
      "x-forwarded-for": "192.0.2.250",
      "cf-connecting-ip": "192.0.2.251",
    });

    expect(forged.status).toBe(429);
    expect(forged.headers.get("set-cookie")).toBeNull();
  });

  it("does not sign anyone in while the database cannot be read", async () => {
    closeDb();

    const file = path.join(dataDir.path, "not-a-directory");

    writeFileSync(file, "x");
    process.env.DATA_DIR = path.join(file, "data");

    const response = await signIn(TOKEN);

    expect(response.status).toBeGreaterThanOrEqual(429);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /api/auth/session", () => {
  const status = async (cookie?: string) =>
    (
      (await (
        await GET(
          new Request("https://gitdiagram.com/api/auth/session", {
            headers: cookie ? { cookie } : {},
          }),
        )
      ).json()) as { admin: boolean }
    ).admin;

  it("says whether this browser is signed in", async () => {
    const cookie = sessionCookie(await signIn(TOKEN));

    expect(await status(cookie)).toBe(true);
    expect(await status()).toBe(false);
    expect(await status("gd_admin=garbage")).toBe(false);
  });
});

describe("DELETE /api/auth/session", () => {
  const signOut = (
    cookie: string,
    everywhere = false,
    origin = "https://gitdiagram.com",
  ) =>
    DELETE(
      new Request(
        `https://gitdiagram.com/api/auth/session${everywhere ? "?everywhere=1" : ""}`,
        { method: "DELETE", headers: { origin, cookie } },
      ),
    );

  it("signs this browser out by clearing the cookie, and no other browser", async () => {
    const laptop = sessionCookie(await signIn(TOKEN));
    const phone = sessionCookie(await signIn(TOKEN));
    const response = await signOut(laptop);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(response.headers.get("set-cookie")).toMatch(/;\s*HttpOnly/i);
    expect(await verifyAdminSession(phone.split("=")[1])).toBe(true);
    expect(await verifyAdminSession(laptop.split("=")[1])).toBe(true); // the cookie is gone, not revoked
  });

  it("signs out everywhere: every other session stops working", async () => {
    const laptop = sessionCookie(await signIn(TOKEN));
    const phone = sessionCookie(await signIn(TOKEN));

    expect((await signOut(laptop, true)).status).toBe(200);
    expect(await verifyAdminSession(phone.split("=")[1])).toBe(false);
    expect(await verifyAdminSession(laptop.split("=")[1])).toBe(false);

    // A session that is already revoked cannot revoke anything.
    expect((await signOut(phone, true)).status).toBe(401);

    // The operator can sign in again.
    const again = await signIn(TOKEN);

    expect(again.status).toBe(200);
    expect(await verifyAdminSession(cookieValue(again))).toBe(true);
  });

  it("needs a valid session to sign out everywhere", async () => {
    const response = await signOut("gd_admin=garbage", true);

    expect(response.status).toBe(401);
  });

  it("refuses to sign out from another site", async () => {
    const cookie = sessionCookie(await signIn(TOKEN));

    expect((await signOut(cookie, false, "https://evil.example")).status).toBe(
      403,
    );
    expect((await signOut(cookie, true, "https://evil.example")).status).toBe(
      403,
    );
  });
});

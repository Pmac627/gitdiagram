import { createHmac } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { closeDb } from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  isOperatorConfigured,
  isOperatorToken,
  revokeAdminSessions,
  verifyAdminRequest,
  verifyAdminSession,
} from "./operator";

const TOKEN = "a".repeat(40);
const originalEnv = { ...process.env };

let dataDir: TempDataDir;

beforeEach(async () => {
  process.env = { ...originalEnv };
  delete process.env.VIDEO_ADMIN_TOKEN;
  process.env.OPERATOR_TOKEN = TOKEN;
  dataDir = await createTempDataDir();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

const request = (cookie: string) =>
  new Request("https://gitdiagram.com/api/admin/state", {
    headers: { cookie },
  });

/** Points DATA_DIR below a regular file, so the database cannot be opened. */
function breakDataDir(): void {
  closeDb();

  const file = path.join(dataDir.path, "not-a-directory");

  writeFileSync(file, "x");
  process.env.DATA_DIR = path.join(file, "data");
}

/** Removes the SQLite file while keeping the configured DATA_DIR unchanged. */
function resetDatabase(): void {
  closeDb();
  rmSync(path.join(dataDir.path, "gitdiagram.db"), { force: true });
  rmSync(path.join(dataDir.path, "gitdiagram.db-wal"), { force: true });
  rmSync(path.join(dataDir.path, "gitdiagram.db-shm"), { force: true });
}

function legacySession(version: "v1" | "v2", expires: number): string {
  const payload =
    version === "v1"
      ? `admin-session:v1:${expires}`
      : `admin-session:v2:${expires}:0`;
  const signature = createHmac("sha256", TOKEN)
    .update(payload)
    .digest("base64url");

  return version === "v1"
    ? `${version}.${expires}.${signature}`
    : `${version}.${expires}.0.${signature}`;
}

describe("operator token", () => {
  it("reads OPERATOR_TOKEN and accepts only that token, whatever length is sent", () => {
    expect(isOperatorToken(TOKEN)).toBe(true);
    expect(isOperatorToken(` ${TOKEN} `)).toBe(true);
    expect(isOperatorToken(`${TOKEN}x`)).toBe(false);
    expect(isOperatorToken("")).toBe(false);
    expect(isOperatorToken("a")).toBe(false);
    expect(isOperatorToken("a".repeat(4_000))).toBe(false);
  });

  it("falls back to VIDEO_ADMIN_TOKEN when OPERATOR_TOKEN is not set", () => {
    delete process.env.OPERATOR_TOKEN;
    process.env.VIDEO_ADMIN_TOKEN = "b".repeat(40);

    expect(isOperatorConfigured()).toBe(true);
    expect(isOperatorToken("b".repeat(40))).toBe(true);
    expect(isOperatorToken(TOKEN)).toBe(false);
  });

  it("prefers OPERATOR_TOKEN over VIDEO_ADMIN_TOKEN when both are set", () => {
    process.env.VIDEO_ADMIN_TOKEN = "b".repeat(40);

    expect(isOperatorToken(TOKEN)).toBe(true);
    expect(isOperatorToken("b".repeat(40))).toBe(false);
  });

  it("is not configured when neither variable is set or the token is too short", () => {
    expect(isOperatorConfigured()).toBe(true);

    process.env.OPERATOR_TOKEN = "too short to be safe";
    expect(isOperatorConfigured()).toBe(false);
    expect(isOperatorToken("too short to be safe")).toBe(false);

    delete process.env.OPERATOR_TOKEN;
    expect(isOperatorConfigured()).toBe(false);
    expect(isOperatorToken("")).toBe(false);
  });
});

describe("operator sessions", () => {
  it("issues sessions that expire after 30 days and cannot be forged", async () => {
    const now = Date.now();
    const session = (await createAdminSession(now))!;

    expect(session.maxAgeSeconds).toBe(30 * 86_400);
    expect(await verifyAdminSession(session.value, now)).toBe(true);
    expect(
      await verifyAdminSession(
        session.value,
        now + session.maxAgeSeconds * 1000,
      ),
    ).toBe(false);

    const [version, expiry, generation, signature] = session.value.split(".");

    expect(version).toBe("v3");
    expect(
      await verifyAdminSession(
        `${version}.${Number(expiry) + 1}.${generation}.${signature}`,
        now,
      ),
    ).toBe(false);
    expect(
      await verifyAdminSession(
        `${version}.${expiry}.${generation}.${signature}x`,
        now,
      ),
    ).toBe(false);
    // The generation is signed too.
    expect(
      await verifyAdminSession(`${version}.${expiry}.7.${signature}`, now),
    ).toBe(false);
    expect(await verifyAdminSession(undefined, now)).toBe(false);
    expect(await verifyAdminSession("", now)).toBe(false);
    expect(await verifyAdminSession("garbage", now)).toBe(false);
  });

  it("refuses to issue a session when no token is configured", async () => {
    delete process.env.OPERATOR_TOKEN;

    expect(await createAdminSession()).toBeNull();
  });

  it("signs every session out when the token rotates", async () => {
    const session = (await createAdminSession())!;

    process.env.OPERATOR_TOKEN = "b".repeat(40);

    expect(await verifyAdminSession(session.value)).toBe(false);
  });

  it("rejects every session when no token is configured (fail closed)", async () => {
    const session = (await createAdminSession())!;

    delete process.env.OPERATOR_TOKEN;

    expect(await verifyAdminSession(session.value)).toBe(false);
  });

  it("reads the session from the request's cookies", async () => {
    const session = (await createAdminSession())!;

    expect(
      await verifyAdminRequest(
        request(`theme=dark; ${ADMIN_SESSION_COOKIE}=${session.value}`),
      ),
    ).toBe(true);
    expect(await verifyAdminRequest(request(`other=${session.value}`))).toBe(
      false,
    );
    expect(await verifyAdminRequest(request(""))).toBe(false);
  });

  it("keeps new-format cookies valid when the same SQLite database is reopened", async () => {
    const session = (await createAdminSession())!;

    expect(session.value.split(".")[0]).toBe("v3");
    expect(await verifyAdminSession(session.value)).toBe(true);

    closeDb();

    expect(await verifyAdminSession(session.value)).toBe(true);
  });

  it("rejects a cookie after its SQLite database is deleted and recreated", async () => {
    const session = (await createAdminSession())!;

    resetDatabase();

    expect(await verifyAdminSession(session.value)).toBe(false);
  });

  it("rejects a cookie after sign-out-everywhere and database recreation", async () => {
    const session = (await createAdminSession())!;

    await revokeAdminSessions();
    expect(await verifyAdminSession(session.value)).toBe(false);

    resetDatabase();

    expect(await verifyAdminSession(session.value)).toBe(false);
  });

  it.each(["v1", "v2"] as const)(
    "rejects a legacy %s cookie after migration",
    async (version) => {
      const now = Date.now();
      const expires = now + 86_400_000;
      const legacy = legacySession(version, expires);

      expect(await verifyAdminSession(legacy, now)).toBe(false);
    },
  );
});

describe("signing out everywhere", () => {
  it("ends every earlier session at once, and new ones still work", async () => {
    const laptop = (await createAdminSession())!;
    const phone = (await createAdminSession())!;

    expect(await verifyAdminSession(phone.value)).toBe(true);

    await revokeAdminSessions();

    expect(await verifyAdminSession(laptop.value)).toBe(false);
    expect(await verifyAdminSession(phone.value)).toBe(false);
    expect(
      await verifyAdminRequest(
        request(`${ADMIN_SESSION_COOKIE}=${laptop.value}`),
      ),
    ).toBe(false);

    const after = (await createAdminSession())!;

    expect(await verifyAdminSession(after.value)).toBe(true);
  });

  it("takes effect immediately, with no per-instance cache delay", async () => {
    const now = Date.now();
    const session = (await createAdminSession(now))!;

    expect(await verifyAdminSession(session.value, now)).toBe(true);

    await revokeAdminSessions();

    expect(await verifyAdminSession(session.value, now + 1)).toBe(false);
  });

  it("returns the new generation number", async () => {
    expect(await revokeAdminSessions()).toBe(1);
    expect(await revokeAdminSessions()).toBe(2);
  });
});

describe("when the session store cannot be read", () => {
  it("rejects a correctly signed, unexpired session (fail closed)", async () => {
    const session = (await createAdminSession())!;

    expect(await verifyAdminSession(session.value)).toBe(true);

    breakDataDir();

    expect(await verifyAdminSession(session.value)).toBe(false);
    expect(
      await verifyAdminRequest(
        request(`${ADMIN_SESSION_COOKIE}=${session.value}`),
      ),
    ).toBe(false);
  });

  it("rejects the session when DATA_DIR is unset", async () => {
    const session = (await createAdminSession())!;

    closeDb();
    delete process.env.DATA_DIR;

    expect(await verifyAdminSession(session.value)).toBe(false);
  });

  it("issues no session and cannot sign out everywhere", async () => {
    breakDataDir();

    expect(await createAdminSession()).toBeNull();
    await expect(revokeAdminSessions()).rejects.toThrow();
  });
});

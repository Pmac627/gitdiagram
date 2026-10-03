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
} from "~/server/auth/operator";
import { closeDb } from "~/server/storage/db";

import * as limits from "./limits";

const {
  generationLockName,
  isTrustedVideoCaller,
  isVideoAdmin,
  isVideoLockHeld,
  pausedMessage,
  tryPaidVideoRun,
  tryVideoLock,
} = limits;

const TOKEN = "t".repeat(40);
const originalEnv = { ...process.env };

const request = (authorization?: string, cookie?: string) =>
  new Request("https://gitdiagram.com/api/video/generate", {
    method: "POST",
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });

async function signedInCookie(): Promise<string> {
  return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession())!.value}`;
}

let dataDir: TempDataDir;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = { ...originalEnv, OPERATOR_TOKEN: TOKEN };
  delete process.env.VIDEO_ADMIN_TOKEN;
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  vi.useRealTimers();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

describe("explainer video limits", () => {
  it("does not recognize the operator token as a Bearer (cookie sessions only)", async () => {
    expect(await isVideoAdmin(request(`Bearer ${TOKEN}`))).toBe(false);
    expect(await isVideoAdmin(request(`Bearer ${TOKEN}x`))).toBe(false);
    expect(await isVideoAdmin(request(TOKEN))).toBe(false);
    expect(await isVideoAdmin(request())).toBe(false);
    process.env.OPERATOR_TOKEN = "short";
    expect(await isVideoAdmin(request("Bearer short"))).toBe(false);
  });

  it("treats every signed-in request as the operator", async () => {
    const cookie = await signedInCookie();

    expect(await isVideoAdmin(request(undefined, cookie))).toBe(true);
    expect(await isTrustedVideoCaller(request(undefined, cookie))).toBe(true);
  });

  it("does not trust a forged, revoked or unconfigured session", async () => {
    const cookie = await signedInCookie();
    const forged = `${ADMIN_SESSION_COOKIE}=v2.9999999999999.0.forged`;

    expect(await isVideoAdmin(request(undefined, forged))).toBe(false);
    expect(await isTrustedVideoCaller(request(undefined, forged))).toBe(false);

    await revokeAdminSessions();

    expect(await isVideoAdmin(request(undefined, cookie))).toBe(false);
    expect(await isTrustedVideoCaller(request(undefined, cookie))).toBe(false);

    const fresh = await signedInCookie();

    delete process.env.OPERATOR_TOKEN;

    expect(await isVideoAdmin(request(undefined, fresh))).toBe(false);
    expect(await isTrustedVideoCaller(request(undefined, fresh))).toBe(false);
  });

  it("no longer trusts unsigned callers in local development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await isTrustedVideoCaller(request())).toBe(false);
    expect(await isTrustedVideoCaller(request(`Bearer ${TOKEN}`))).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(await isTrustedVideoCaller(request())).toBe(false);
    expect(await isTrustedVideoCaller(request(`Bearer ${TOKEN}`))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("locks once, and only the holder's release frees it", async () => {
    const release = await tryVideoLock("generate:a/b", 60_000);
    expect(release).toBeTypeOf("function");
    expect(await tryVideoLock("generate:a/b", 60_000)).toBeNull();
    // Another repository is independent.
    const other = await tryVideoLock("generate:a/c", 60_000);
    expect(other).toBeTypeOf("function");

    await release?.();
    const next = await tryVideoLock("generate:a/b", 60_000);
    expect(next).toBeTypeOf("function");
    await next?.();
    await other?.();
  });

  it("lets a lock expire on its own, and an expired holder cannot free the next one's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
    const first = await tryVideoLock("generate:a/b", 1_000);
    expect(first).toBeTypeOf("function");
    expect(await isVideoLockHeld("generate:a/b")).toBe(true);

    vi.setSystemTime(new Date("2026-09-29T10:00:02.000Z"));
    expect(await isVideoLockHeld("generate:a/b")).toBe(false);
    const second = await tryVideoLock("generate:a/b", 60_000);
    expect(second).toBeTypeOf("function");

    await first?.();
    expect(await isVideoLockHeld("generate:a/b")).toBe(true);
    await second?.();
    expect(await isVideoLockHeld("generate:a/b")).toBe(false);
  });

  it("keeps a lock across a reopened database, as a second process would see it", async () => {
    const release = await tryVideoLock("generate:a/b", 60_000);
    closeDb();

    expect(await isVideoLockHeld("generate:a/b")).toBe(true);
    expect(await tryVideoLock("generate:a/b", 60_000)).toBeNull();
    await release?.();
    expect(await isVideoLockHeld("generate:a/b")).toBe(false);
  });

  it("tells whether a repository's generation lock is held", async () => {
    const name = generationLockName("Acme", "Demo");
    expect(name).toBe("generate:acme/demo");
    expect(await isVideoLockHeld(name)).toBe(false);

    const release = await tryVideoLock(name, 60_000);
    expect(await isVideoLockHeld(name)).toBe(true);
    await release?.();
    expect(await isVideoLockHeld(name)).toBe(false);
  });

  it("answers false, not an error, when the database cannot be read", async () => {
    delete process.env.DATA_DIR;

    expect(await isVideoLockHeld("generate:a/b")).toBe(false);
  });

  it("caps paid runs at once, counting the operator's but never refusing them", async () => {
    process.env.VIDEO_MAX_PAID_RUNS = "2";

    const first = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    const second = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();

    const operator = await tryPaidVideoRun({ operator: true, ttlMs: 60_000 });
    expect(operator).toBeTypeOf("function");

    // The operator's run holds a place too: freeing one leaves 2 of 2 taken.
    await first?.();
    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();
    await operator?.();
    const again = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    expect(again).toBeTypeOf("function");
    await again?.();
    await second?.();
  });

  it("defaults the cap to 10 paid runs", async () => {
    delete process.env.VIDEO_MAX_PAID_RUNS;
    const releases: Array<(() => Promise<void>) | null> = [];

    for (let index = 0; index < 10; index += 1) {
      releases.push(await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }));
    }

    expect(releases.every((release) => release !== null)).toBe(true);
    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();
  });

  it("releases a place once, so a second release never frees someone else's", async () => {
    process.env.VIDEO_MAX_PAID_RUNS = "1";
    const first = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    await first?.();
    const second = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    expect(second).toBeTypeOf("function");

    await first?.();

    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();
    await second?.();
  });

  it("reclaims the place of a run that died without releasing it", async () => {
    process.env.VIDEO_MAX_PAID_RUNS = "1";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
    const died = await tryPaidVideoRun({ operator: false, ttlMs: 1_000 });
    expect(died).toBeTypeOf("function");
    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();

    vi.setSystemTime(new Date("2026-09-29T10:00:02.000Z"));
    const reclaimed = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    expect(reclaimed).toBeTypeOf("function");

    // The dead run's late release must not free the reclaimed place.
    await died?.();
    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();
  });

  it("keeps paid-run places across a reopened database", async () => {
    process.env.VIDEO_MAX_PAID_RUNS = "1";
    const first = await tryPaidVideoRun({ operator: false, ttlMs: 60_000 });
    closeDb();

    expect(
      await tryPaidVideoRun({ operator: false, ttlMs: 60_000 }),
    ).toBeNull();
    await first?.();
  });

  it("says a pause is a pause, not a spent daily budget", () => {
    // Only the voice pause is left (the operator's switch is gone, Phase 4
    // decision 1). It lifts within minutes and is not "today's videos have
    // all been made".
    expect(pausedMessage("voice")).toMatch(/paused for a few minutes/);
    expect(pausedMessage("voice")).not.toMatch(/all been made|hours/);
  });

  it("no longer offers per-person, per-network, premium, attempt or render budgets", () => {
    const removed = [
      "reserveVideoSlot",
      "takePremiumVideo",
      "reserveRenderSlot",
      "videoLimitReached",
      "videoUsageToday",
      "resetUsageToday",
      "takeVideoAttempt",
      "limitMessage",
      "attemptLimitMessage",
      "renderLimitMessage",
    ];

    for (const name of removed) {
      expect(Object.keys(limits), `${name} must be removed`).not.toContain(
        name,
      );
    }
  });
});

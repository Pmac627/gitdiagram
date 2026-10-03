import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import { closeDb } from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

import * as guard from "./sign-in-guard";
import { checkSignIn } from "./sign-in-guard";

// The guard is global: one wrong-token counter for the whole site, kept in
// SQLite. The origin can be reached directly, so x-forwarded-for and
// cf-connecting-ip can be forged; nothing here may depend on them.

const TOKEN = "a".repeat(40);
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const originalEnv = { ...process.env };

let dataDir: TempDataDir;

const request = (headers: Record<string, string> = {}) =>
  new Request("https://gitdiagram.com/api/auth/session", {
    method: "POST",
    headers,
  });

beforeEach(async () => {
  process.env = { ...originalEnv, OPERATOR_TOKEN: TOKEN };
  delete process.env.VIDEO_ADMIN_TOKEN;
  dataDir = await createTempDataDir();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await dataDir.dispose();
  process.env = { ...originalEnv };
});

async function failTimes(count: number, ip?: () => string): Promise<void> {
  for (let attempt = 0; attempt < count; attempt++) {
    await checkSignIn(request(ip ? { "x-forwarded-for": ip() } : {}), false);
  }
}

describe("checkSignIn", () => {
  it("lets the first ten wrong tokens through and blocks the eleventh", async () => {
    for (let attempt = 1; attempt <= MAX_FAILURES; attempt++) {
      const check = await checkSignIn(request(), false);

      expect(check.blocked, `wrong token ${attempt}`).toBe(false);
    }

    const blocked = await checkSignIn(request(), false);

    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  it("does not count the right token, and lets it in while the counter is low", async () => {
    await failTimes(3);

    for (let attempt = 0; attempt < 50; attempt++) {
      expect((await checkSignIn(request(), true)).blocked).toBe(false);
    }

    // Still only 3 failures on record: seven more fit.
    await failTimes(7);
    expect((await checkSignIn(request(), false)).blocked).toBe(true);
  });

  it("refuses even the right token once the failures are used up, until the window ends", async () => {
    await failTimes(MAX_FAILURES);

    expect((await checkSignIn(request(), true)).blocked).toBe(true);

    vi.setSystemTime(Date.now() + WINDOW_MS - 1_000);

    expect((await checkSignIn(request(), true)).blocked).toBe(true);

    vi.setSystemTime(Date.now() + 2_000);

    expect((await checkSignIn(request(), true)).blocked).toBe(false);
    expect((await checkSignIn(request(), false)).blocked).toBe(false);
  });

  it("does not let more wrong tokens stretch the window", async () => {
    await failTimes(MAX_FAILURES + 5);

    vi.setSystemTime(Date.now() + WINDOW_MS + 1_000);

    expect((await checkSignIn(request(), true)).blocked).toBe(false);
  });

  it("is global: a forged x-forwarded-for cannot get around it", async () => {
    let next = 0;

    await failTimes(MAX_FAILURES, () => `203.0.113.${++next}`);

    const forged = await checkSignIn(
      request({ "x-forwarded-for": "198.51.100.200" }),
      true,
    );

    expect(forged.blocked).toBe(true);
    expect(
      (
        await checkSignIn(
          request({
            "x-forwarded-for": "198.51.100.201",
            "cf-connecting-ip": "198.51.100.202",
            "x-real-ip": "198.51.100.203",
          }),
          false,
        )
      ).blocked,
    ).toBe(true);
  });

  it("counts requests that carry no address at all", async () => {
    await failTimes(MAX_FAILURES);

    expect((await checkSignIn(request(), false)).blocked).toBe(true);
  });

  it("keeps the count across a restart, because it lives in SQLite", async () => {
    await failTimes(MAX_FAILURES);
    closeDb();

    expect((await checkSignIn(request(), true)).blocked).toBe(true);
  });

  it("has no announce field any more", async () => {
    const wrong = await checkSignIn(request(), false);
    const right = await checkSignIn(request(), true);

    expect(wrong).not.toHaveProperty("announce");
    expect(right).not.toHaveProperty("announce");
  });

  it("fails closed when the database cannot be read", async () => {
    closeDb();

    const file = path.join(dataDir.path, "not-a-directory");

    writeFileSync(file, "x");
    process.env.DATA_DIR = path.join(file, "data");

    const check = await checkSignIn(request(), true);

    expect(check.blocked).toBe(true);
  });
});

describe("no Bearer access", () => {
  it("no longer exports verifyOperatorBearer", () => {
    expect(guard).not.toHaveProperty("verifyOperatorBearer");
  });
});

// Logging choice: one Warning per block window, on the first refusal, so a
// lockout attack is visible without one log line per blocked request.
describe("auth.sign_in.blocked log event", () => {
  function blockedEvents(): Array<Record<string, unknown>> {
    return warn.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && entry.event === "auth.sign_in.blocked",
      );
  }

  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("logs nothing while wrong tokens are still under the limit", async () => {
    await failTimes(MAX_FAILURES);

    expect(blockedEvents()).toEqual([]);
  });

  it("logs one Warning-level event with the retry-after seconds when the throttle first blocks", async () => {
    await failTimes(MAX_FAILURES);
    await checkSignIn(request(), false);

    const events = blockedEvents();

    expect(events).toHaveLength(1);
    expect(events[0]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(events[0]!.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  it("does not log every further blocked attempt in the same window", async () => {
    await failTimes(MAX_FAILURES + 1);

    for (let attempt = 0; attempt < 20; attempt++) {
      await checkSignIn(request(), attempt % 2 === 0);
    }

    expect(blockedEvents()).toHaveLength(1);
  });

  it("logs the first refusal of the right token when the failures are used up", async () => {
    await failTimes(MAX_FAILURES);
    await checkSignIn(request(), true);
    await checkSignIn(request(), true);

    expect(blockedEvents()).toHaveLength(1);
  });

  it("logs again when a new window is blocked", async () => {
    await failTimes(MAX_FAILURES + 1);

    vi.setSystemTime(Date.now() + WINDOW_MS + 1_000);

    await failTimes(MAX_FAILURES + 1);

    expect(blockedEvents()).toHaveLength(2);
  });

  it("never logs the presented token, the client IP or headers", async () => {
    const secretHeaders = {
      "x-forwarded-for": "203.0.113.55",
      "cf-connecting-ip": "203.0.113.56",
      "x-real-ip": "203.0.113.57",
      authorization: "Bearer presented-secret-token",
      cookie: "gd_admin=cookie-secret",
      "user-agent": "unique-agent-string",
    };

    for (let attempt = 0; attempt <= MAX_FAILURES; attempt++) {
      await checkSignIn(request(secretHeaders), false);
    }

    const output = JSON.stringify(warn.mock.calls);

    expect(blockedEvents()).toHaveLength(1);

    for (const leaked of [
      "203.0.113",
      "presented-secret-token",
      "cookie-secret",
      "unique-agent-string",
      TOKEN,
    ]) {
      expect(output).not.toContain(leaked);
    }

    expect(Object.keys(blockedEvents()[0]!).sort()).toEqual(
      expect.not.arrayContaining(["ip", "token", "headers"]),
    );
  });
});

// @vitest-environment node
//
// cancellation.ts on SQLite (Phase 5, step 18a). Exported names, constants and
// signatures are unchanged; state moves from Redis keys to rows in the shared
// database. Expiry is read from Date.now(), so these tests use fake timers.
// Semantics preserved from the Redis Lua scripts:
//   register    : NX (false if a session is already active for the id); promotes
//                 a token-matching pending cancel into a real cancellation flag
//                 and clears a stale pending marker with another token.
//   markCancelled: active session with the same token -> flag set, true;
//                 active session with another token -> false, nothing changes;
//                 no active session -> token-bound pending marker (60 s), false.
//   unregister  : only with the matching token; clears the active row and flag.
//   isGenerationCancelled: true only for a real flag, never for a pending marker.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GENERATION_ACTIVE_TTL_SECONDS,
  GENERATION_CANCELLATION_TTL_SECONDS,
  GENERATION_PENDING_CANCELLATION_TTL_SECONDS,
  isGenerationCancelled,
  markGenerationCancelled,
  registerActiveGeneration,
  startGenerationCancellationPolling,
  unregisterActiveGeneration,
} from "~/server/generate/cancellation";
import { closeDb } from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER_TOKEN = "0b8f4a1e-3f0d-4f5e-9e0e-2f3c1a7d9b11";

let dataDir: TempDataDir;

beforeEach(async () => {
  vi.useFakeTimers();
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await dataDir.dispose();
});

describe("generation cancellation state", () => {
  it("keeps the documented lifetimes", () => {
    expect(GENERATION_ACTIVE_TTL_SECONDS).toBe(360);
    expect(GENERATION_CANCELLATION_TTL_SECONDS).toBe(600);
    expect(GENERATION_PENDING_CANCELLATION_TTL_SECONDS).toBe(60);
  });

  it("registers a session once and never replaces a collision", async () => {
    await expect(registerActiveGeneration(SESSION, TOKEN)).resolves.toBe(true);
    await expect(registerActiveGeneration(SESSION, TOKEN)).resolves.toBe(false);
    await expect(registerActiveGeneration(SESSION, OTHER_TOKEN)).resolves.toBe(
      false,
    );
  });

  it("is not cancelled until its own token cancels it", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    expect(await isGenerationCancelled(SESSION)).toBe(false);

    await expect(markGenerationCancelled(SESSION, OTHER_TOKEN)).resolves.toBe(
      false,
    );
    expect(await isGenerationCancelled(SESSION)).toBe(false);

    await expect(markGenerationCancelled(SESSION, TOKEN)).resolves.toBe(true);
    expect(await isGenerationCancelled(SESSION)).toBe(true);
  });

  it("keeps sessions independent", async () => {
    const other = "11111111-1111-4111-8111-111111111111";
    await registerActiveGeneration(SESSION, TOKEN);
    await registerActiveGeneration(other, TOKEN);

    await markGenerationCancelled(SESSION, TOKEN);

    expect(await isGenerationCancelled(SESSION)).toBe(true);
    expect(await isGenerationCancelled(other)).toBe(false);
  });

  it("promotes a token-matching early cancel when the session registers", async () => {
    await expect(markGenerationCancelled(SESSION, TOKEN)).resolves.toBe(false);
    // A pending marker is not a cancellation flag: polling must ignore it.
    expect(await isGenerationCancelled(SESSION)).toBe(false);

    await expect(registerActiveGeneration(SESSION, TOKEN)).resolves.toBe(true);

    expect(await isGenerationCancelled(SESSION)).toBe(true);
  });

  it("clears a stale early-cancel marker whose token does not match", async () => {
    await markGenerationCancelled(SESSION, OTHER_TOKEN);

    await expect(registerActiveGeneration(SESSION, TOKEN)).resolves.toBe(true);

    expect(await isGenerationCancelled(SESSION)).toBe(false);
    // The stale marker is gone, so a later cancel with the old token does
    // not resurrect it either.
    await expect(markGenerationCancelled(SESSION, OTHER_TOKEN)).resolves.toBe(
      false,
    );
    expect(await isGenerationCancelled(SESSION)).toBe(false);
  });

  it("forgets an early cancel after the pending lifetime", async () => {
    await markGenerationCancelled(SESSION, TOKEN);

    vi.advanceTimersByTime(
      GENERATION_PENDING_CANCELLATION_TTL_SECONDS * 1_000 + 1,
    );
    await registerActiveGeneration(SESSION, TOKEN);

    expect(await isGenerationCancelled(SESSION)).toBe(false);
  });

  it("keeps an early cancel until the pending lifetime ends", async () => {
    await markGenerationCancelled(SESSION, TOKEN);

    vi.advanceTimersByTime(
      GENERATION_PENDING_CANCELLATION_TTL_SECONDS * 1_000 - 1_000,
    );
    await registerActiveGeneration(SESSION, TOKEN);

    expect(await isGenerationCancelled(SESSION)).toBe(true);
  });

  it("lets an expired active session id be registered again", async () => {
    await registerActiveGeneration(SESSION, TOKEN);

    vi.advanceTimersByTime(GENERATION_ACTIVE_TTL_SECONDS * 1_000 - 1_000);
    await expect(registerActiveGeneration(SESSION, OTHER_TOKEN)).resolves.toBe(
      false,
    );

    vi.advanceTimersByTime(2_000);
    await expect(registerActiveGeneration(SESSION, OTHER_TOKEN)).resolves.toBe(
      true,
    );
  });

  it("expires the cancellation flag after its lifetime", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    await markGenerationCancelled(SESSION, TOKEN);

    vi.advanceTimersByTime(GENERATION_CANCELLATION_TTL_SECONDS * 1_000 - 1_000);
    expect(await isGenerationCancelled(SESSION)).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(await isGenerationCancelled(SESSION)).toBe(false);
  });

  it("unregisters only with the matching token", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    await markGenerationCancelled(SESSION, TOKEN);

    await unregisterActiveGeneration(SESSION, OTHER_TOKEN);

    // Still active (registering again collides) and still cancelled.
    await expect(registerActiveGeneration(SESSION, OTHER_TOKEN)).resolves.toBe(
      false,
    );
    expect(await isGenerationCancelled(SESSION)).toBe(true);

    await unregisterActiveGeneration(SESSION, TOKEN);

    expect(await isGenerationCancelled(SESSION)).toBe(false);
    await expect(registerActiveGeneration(SESSION, OTHER_TOKEN)).resolves.toBe(
      true,
    );
  });

  it("unregister is idempotent and harmless for an unknown session", async () => {
    await expect(
      unregisterActiveGeneration(SESSION, TOKEN),
    ).resolves.toBeUndefined();

    await registerActiveGeneration(SESSION, TOKEN);
    await unregisterActiveGeneration(SESSION, TOKEN);
    await expect(
      unregisterActiveGeneration(SESSION, TOKEN),
    ).resolves.toBeUndefined();
  });

  it("shares state across connections (a second process would see it)", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    await markGenerationCancelled(SESSION, TOKEN);

    closeDb();

    expect(await isGenerationCancelled(SESSION)).toBe(true);
  });
});

describe("startGenerationCancellationPolling", () => {
  it("fires onCancelled once, after the flag appears, and then stops", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    const onCancelled = vi.fn();
    const stop = startGenerationCancellationPolling({
      sessionId: SESSION,
      onCancelled,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(onCancelled).not.toHaveBeenCalled();

    await markGenerationCancelled(SESSION, TOKEN);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onCancelled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onCancelled).toHaveBeenCalledTimes(1);
    stop();
  });

  it("notices a cancel that is already set on the first poll", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    await markGenerationCancelled(SESSION, TOKEN);
    const onCancelled = vi.fn();

    const stop = startGenerationCancellationPolling({
      sessionId: SESSION,
      onCancelled,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onCancelled).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not fire after being stopped", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    const onCancelled = vi.fn();
    const stop = startGenerationCancellationPolling({
      sessionId: SESSION,
      onCancelled,
    });

    stop();
    await markGenerationCancelled(SESSION, TOKEN);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("polls every second for 15 s, every 3 s until 60 s, then every 5 s", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    const detectedAt: number[] = [];
    const start = Date.now();
    const stop = startGenerationCancellationPolling({
      sessionId: SESSION,
      onCancelled: () => detectedAt.push(Date.now() - start),
    });

    // Polls run at 0..15 s (1 s apart), then 18, 21, ... 60 s, then 65, 70 s.
    await vi.advanceTimersByTimeAsync(19_000);
    await markGenerationCancelled(SESSION, TOKEN);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(detectedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(detectedAt).toEqual([21_000]);
    stop();

    await unregisterActiveGeneration(SESSION, TOKEN);
    await registerActiveGeneration(SESSION, TOKEN);
    const later: number[] = [];
    const laterStart = Date.now();
    const stopLater = startGenerationCancellationPolling({
      sessionId: SESSION,
      onCancelled: () => later.push(Date.now() - laterStart),
    });
    await vi.advanceTimersByTimeAsync(61_000);
    await markGenerationCancelled(SESSION, TOKEN);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(later).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(later).toEqual([65_000]);
    stopLater();
  });

  it("keeps polling after a storage failure and logs only sanitized context", async () => {
    await registerActiveGeneration(SESSION, TOKEN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onCancelled = vi.fn();
    const realDir = dataDir.path;
    // A DATA_DIR that is a file makes every storage call fail.
    const brokenDir = path.join(realDir, "not-a-directory");
    writeFileSync(brokenDir, "x");
    process.env.DATA_DIR = brokenDir;

    const stop = startGenerationCancellationPolling({
      sessionId: SESSION,
      onCancelled,
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(onCancelled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "Cancellation status is temporarily unavailable",
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(realDir);

    process.env.DATA_DIR = realDir;
    await markGenerationCancelled(SESSION, TOKEN);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(onCancelled).toHaveBeenCalledTimes(1);
    stop();
  });
});

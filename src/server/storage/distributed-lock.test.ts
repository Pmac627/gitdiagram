// @vitest-environment node
//
// distributed-lock.ts on SQLite (Phase 5, step 18a). Signatures are unchanged;
// the lock is a row with an expiry timestamp in the shared database, so it
// works across processes (IIS overlapped recycles). Time comes from
// Date.now(), so these tests use fake timers. Guarantees preserved from the
// Redis version (SET NX PX + compare-and-delete release):
//   - one holder per key at a time, no waiting for tryDistributedLock;
//   - an expired lock can be taken by someone else;
//   - only the owner's token releases: a holder whose lock expired never
//     frees the next holder's lock;
//   - release never throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb } from "~/server/storage/db";
import {
  tryDistributedLock,
  withDistributedLock,
} from "~/server/storage/distributed-lock";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

let dataDir: TempDataDir;

beforeEach(async () => {
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  vi.useRealTimers();
  await dataDir.dispose();
});

describe("tryDistributedLock", () => {
  it("returns a release function when the lock is free, else null", async () => {
    const release = await tryDistributedLock({ key: "lock:a", ttlMs: 60_000 });

    expect(release).toBeTypeOf("function");
    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 60_000 }),
    ).resolves.toBeNull();
  });

  it("keeps different keys independent", async () => {
    const first = await tryDistributedLock({ key: "lock:a", ttlMs: 60_000 });
    const second = await tryDistributedLock({ key: "lock:b", ttlMs: 60_000 });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it("frees the lock on release, and release is idempotent", async () => {
    const release = await tryDistributedLock({ key: "lock:a", ttlMs: 60_000 });

    await release!();
    await release!();

    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 60_000 }),
    ).resolves.not.toBeNull();
  });

  it("lets another caller take the lock once it has expired", async () => {
    vi.useFakeTimers();
    await tryDistributedLock({ key: "lock:a", ttlMs: 1_000 });

    vi.advanceTimersByTime(999);
    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 1_000 }),
    ).resolves.toBeNull();

    vi.advanceTimersByTime(2);
    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 1_000 }),
    ).resolves.not.toBeNull();
  });

  it("never lets a holder whose lock expired free the next holder's lock", async () => {
    vi.useFakeTimers();
    const staleRelease = await tryDistributedLock({
      key: "lock:a",
      ttlMs: 1_000,
    });
    vi.advanceTimersByTime(1_500);
    const currentRelease = await tryDistributedLock({
      key: "lock:a",
      ttlMs: 60_000,
    });
    expect(currentRelease).not.toBeNull();

    await staleRelease!();

    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 60_000 }),
    ).resolves.toBeNull();
    await currentRelease!();
    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 60_000 }),
    ).resolves.not.toBeNull();
  });

  it("is visible across connections: a held lock survives a reopen of the database", async () => {
    await tryDistributedLock({ key: "lock:a", ttlMs: 60_000 });

    closeDb();

    await expect(
      tryDistributedLock({ key: "lock:a", ttlMs: 60_000 }),
    ).resolves.toBeNull();
  });
});

describe("withDistributedLock", () => {
  it("runs the callback under the lock, returns its value and releases", async () => {
    let heldInside: unknown = "unset";

    const result = await withDistributedLock({
      key: "lock:test",
      callback: async () => {
        heldInside = await tryDistributedLock({
          key: "lock:test",
          ttlMs: 1_000,
        });

        return "saved";
      },
    });

    expect(result).toBe("saved");
    expect(heldInside).toBeNull();
    await expect(
      tryDistributedLock({ key: "lock:test", ttlMs: 1_000 }),
    ).resolves.not.toBeNull();
  });

  it("still releases the lock when the protected write fails", async () => {
    const failure = new Error("write failed");

    await expect(
      withDistributedLock({
        key: "lock:test",
        callback: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    await expect(
      tryDistributedLock({ key: "lock:test", ttlMs: 1_000 }),
    ).resolves.not.toBeNull();
  });

  it("defaults to a 30 s lease", async () => {
    vi.useFakeTimers();
    let insideAt29s: unknown = "unset";
    let insideAt31s: unknown = "unset";

    await withDistributedLock({
      key: "lock:test",
      callback: async () => {
        vi.advanceTimersByTime(29_000);
        insideAt29s = await tryDistributedLock({ key: "lock:test", ttlMs: 1 });
        vi.advanceTimersByTime(2_000);
        insideAt31s = await tryDistributedLock({ key: "lock:test", ttlMs: 1 });
      },
    });

    expect(insideAt29s).toBeNull();
    expect(insideAt31s).not.toBeNull();
  });

  it("waits for a held lock and proceeds once it is released", async () => {
    vi.useFakeTimers();
    const release = await tryDistributedLock({
      key: "lock:test",
      ttlMs: 60_000,
    });
    const callback = vi.fn().mockResolvedValue("second");

    const pending = withDistributedLock({
      key: "lock:test",
      callback,
      waitMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(callback).not.toHaveBeenCalled();

    await release!();
    await vi.advanceTimersByTimeAsync(300);

    await expect(pending).resolves.toBe("second");
    expect(callback).toHaveBeenCalledOnce();
  });

  it("takes over a lock that expires while it waits", async () => {
    vi.useFakeTimers();
    await tryDistributedLock({ key: "lock:test", ttlMs: 500 });

    const pending = withDistributedLock({
      key: "lock:test",
      callback: async () => "took over",
      waitMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("took over");
  });

  it("times out with the key in the message, without running the callback", async () => {
    vi.useFakeTimers();
    await tryDistributedLock({ key: "lock:test", ttlMs: 60_000 });
    const callback = vi.fn();

    const pending = withDistributedLock({
      key: "lock:test",
      callback,
      waitMs: 300,
    });
    const assertion = expect(pending).rejects.toThrow(
      "Timed out waiting for distributed lock: lock:test",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(callback).not.toHaveBeenCalled();
  });

  it("serializes concurrent callers on the same key", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((id) =>
        withDistributedLock({
          key: "lock:test",
          callback: async () => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push(id);
            running -= 1;
          },
        }),
      ),
    );

    expect(maxRunning).toBe(1);
    expect(order).toHaveLength(3);
  });
});

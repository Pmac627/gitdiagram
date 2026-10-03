import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminState } from "~/features/admin/types";
import { useAdminState } from "./use-admin-state";

const adminState = (overrides: Partial<AdminState> = {}): AdminState => ({
  now: 0,
  voicePausedUntil: null,
  voiceCreditUsd: null,
  ...overrides,
});

/** A response the test hands back whenever it likes (or the caller aborts). */
function deferred(signal?: AbortSignal | null) {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    signal?.addEventListener("abort", () => fail(signal.reason));
  });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

let reads: Array<ReturnType<typeof deferred>>;
let writes: Array<ReturnType<typeof deferred>>;

beforeEach(() => {
  reads = [];
  writes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      const next = deferred(init?.signal);
      (path === "/api/admin/state" ? reads : writes).push(next);
      return next.promise;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function loaded() {
  const hook = renderHook(() => useAdminState());
  await act(async () => reads[0]!.resolve(json(adminState())));
  return hook;
}

describe("the dashboard's polled state", () => {
  // Phase 4 decision (1): the pause switch is gone, so the hook only reads.
  it("only reads: it offers no change, saving or saveError", async () => {
    const { result } = await loaded();

    expect(result.current).not.toHaveProperty("change");
    expect(result.current).not.toHaveProperty("saving");
    expect(result.current).not.toHaveProperty("saveError");
    expect(result.current.state?.voiceCreditUsd).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("lets only the newest read land", async () => {
    const { result } = await loaded();

    act(() => void result.current.refresh());
    act(() => void result.current.refresh());
    // The newer read answers first; the older one arrives late and is ignored.
    await act(async () =>
      reads[2]!.resolve(json(adminState({ voiceCreditUsd: 7 }))),
    );
    await act(async () =>
      reads[1]!.resolve(json(adminState({ voiceCreditUsd: 3 }))),
    );

    expect(result.current.state?.voiceCreditUsd).toBe(7);
  });

  it("gives up on a read that hangs, so polls carry on", async () => {
    vi.useFakeTimers();
    renderHook(() => useAdminState());
    expect(reads).toHaveLength(1);
    // The read never answers; after ten seconds it is dropped.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(reads).toHaveLength(2);
  });

  it("goes back to sign-in when a read finds the session gone", async () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload,
    });
    renderHook(() => useAdminState());
    await act(async () =>
      reads[0]!.resolve(json({ error: "Sign in first." }, 401)),
    );
    expect(reload).toHaveBeenCalled();
  });

  it("skips a poll while a read is already on its way", async () => {
    vi.useFakeTimers();
    renderHook(() => useAdminState());
    expect(reads).toHaveLength(1);
    act(() => vi.advanceTimersByTime(15_000));
    expect(reads).toHaveLength(1);
    await act(async () => reads[0]!.resolve(json(adminState())));
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(5_000));
    expect(reads).toHaveLength(2);
  });
});

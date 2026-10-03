import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  voiceCreditUsd: vi.fn(),
  removedDependency: vi.fn(),
}));

// Removed in Phase 3: the per-day video and render budgets no longer exist.
// The tripwires record a call so a test can assert the state never reads them.
vi.mock("~/server/explainer/limits", () => ({
  videoUsageToday: async () => {
    mocks.removedDependency("limits.videoUsageToday");
    return null;
  },
}));
vi.mock("~/server/explainer/voice", () => ({
  voiceCreditUsd: mocks.voiceCreditUsd,
  voicePausedUntil: async () => null,
}));
vi.mock("~/server/generate/complimentary-gate", () => ({
  readComplimentaryUsageToday: async () => {
    mocks.removedDependency("complimentary-gate.readComplimentaryUsageToday");
    return null;
  },
}));

const never = () => new Promise<never>(() => undefined);

/** A fresh instance: no balance cached from another test. */
const load = async () => {
  vi.resetModules();
  return (await import("./state")).readAdminState;
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.voiceCreditUsd.mockResolvedValue(12.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** Reads the state, moving the clock on so deadlines can pass. */
async function read(readAdminState: Awaited<ReturnType<typeof load>>) {
  const state = readAdminState();
  await vi.advanceTimersByTimeAsync(3_000);
  return state;
}

describe("the dashboard's state", () => {
  it("shows a slow voice balance as unreadable instead of holding up the poll", async () => {
    const readAdminState = await load();
    mocks.voiceCreditUsd.mockImplementation(never);
    const state = await read(readAdminState);
    expect(state.voiceCreditUsd).toBeNull();
  });

  it("asks OpenRouter for the voice balance at most every half minute", async () => {
    const readAdminState = await load();
    expect((await read(readAdminState)).voiceCreditUsd).toBe(12.5);
    mocks.voiceCreditUsd.mockResolvedValue(11);
    expect((await read(readAdminState)).voiceCreditUsd).toBe(12.5);
    expect(mocks.voiceCreditUsd).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await read(readAdminState)).voiceCreditUsd).toBe(11);
  });

  it("reports no Vercel deployment details (the fork runs on IIS)", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef");
    vi.stubEnv("VERCEL_REGION", "iad1");
    const readAdminState = await load();
    expect(await read(readAdminState)).not.toHaveProperty("deployment");
  });

  it("keeps a late voice balance for the next poll", async () => {
    const readAdminState = await load();
    let answer!: (usd: number) => void;
    mocks.voiceCreditUsd.mockImplementation(
      () => new Promise<number>((resolve) => (answer = resolve)),
    );
    expect((await read(readAdminState)).voiceCreditUsd).toBeNull();
    answer(9);
    expect((await read(readAdminState)).voiceCreditUsd).toBe(9);
    expect(mocks.voiceCreditUsd).toHaveBeenCalledTimes(1);
  });

  it("reports no video or render budget and no complimentary token usage", async () => {
    const readAdminState = await load();
    const state = await read(readAdminState);

    expect(state).not.toHaveProperty("video");
    expect(state).not.toHaveProperty("diagramQuota");
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  // Phase 4 decision (1): the pause switch is gone, so the state carries no
  // switches and no "switches unreadable" flag.
  it("reports no live switches and no unreadable-switches flag", async () => {
    const readAdminState = await load();
    const state = await read(readAdminState);

    expect(state).not.toHaveProperty("controls");
    expect(state).not.toHaveProperty("controlsUnreadable");
    expect(state).toHaveProperty("voiceCreditUsd", 12.5);
    expect(state).toHaveProperty("voicePausedUntil");
  });
});

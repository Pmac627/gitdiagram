// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Limits from "~/server/explainer/limits";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  generateExplainerVideo: vi.fn(),
  isNarrationAvailable: vi.fn(),
  readVideoArtifact: vi.fn(),
  removedDependency: vi.fn(),
  choosePlanner: vi.fn(),
  tryVideoLock: vi.fn(),
  releaseLock: vi.fn(async () => undefined),
  tryPaidVideoRun: vi.fn(),
  releaseRun: vi.fn(async () => undefined),
  refreshVideoPages: vi.fn(),
  remakePosterRemotely: vi.fn(
    async (
      _artifact: unknown,
      _origin: string,
      _options: { timeoutMs: number },
    ) => true,
  ),
  afterTasks: [] as Array<() => Promise<void>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("~/server/explainer/cache", () => ({
  refreshVideoPages: mocks.refreshVideoPages,
}));
vi.mock("~/server/explainer/config", () => ({
  canGenerateVideos: () => true,
  isVideoExplainerEnabled: () => true,
  isVideoRenderEnabled: () => process.env.VIDEO_RENDER_ENABLED?.trim() === "1",
}));
vi.mock("~/server/explainer/generate", () => ({
  generateExplainerVideo: mocks.generateExplainerVideo,
}));
vi.mock("~/server/explainer/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof Limits>()),
  // Removed in Phase 3. If the route still reaches for a budget, the real
  // function would hit Redis; this records the call and fails instead.
  reserveVideoSlot: mocks.removedDependency,
  takePremiumVideo: mocks.removedDependency,
  takeVideoAttempt: mocks.removedDependency,
  tryPaidVideoRun: mocks.tryPaidVideoRun,
  tryVideoLock: mocks.tryVideoLock,
}));
vi.mock("~/server/explainer/narration", () => ({
  isNarrationAvailable: mocks.isNarrationAvailable,
}));
vi.mock("~/server/explainer/planner", () => ({
  choosePlanner: async (params: unknown) => {
    mocks.choosePlanner(params);
    return { planner: {} };
  },
}));
vi.mock("~/server/explainer/segments", () => ({
  remakePosterRemotely: mocks.remakePosterRemotely,
}));
vi.mock("~/server/explainer/store", () => ({
  readVideoArtifact: mocks.readVideoArtifact,
}));

import { VideoRefusalError } from "~/server/explainer/director";
import { VideoInputError } from "~/server/explainer/repository";
import { VoiceUnavailableError } from "~/server/explainer/voice";
import { registerOperatorSession } from "~/server/auth/test-session";
import { POST } from "./route";

const session = registerOperatorSession();

function request(
  cookie: string | null = null,
  headers: Record<string, string> = {},
  body: Record<string, unknown> = { username: "acme", repo: "demo" },
) {
  return new Request("https://gitdiagram.com/api/video/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://gitdiagram.com",
      "x-forwarded-for": "203.0.113.9",
      cookie: cookie ? `${session.cookie}; ${cookie}` : session.cookie,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Run a request to the end: its SSE events and the after() work. */
async function run(req = request()) {
  const response = await POST(req);
  const text = response.body ? await response.text() : "";
  for (const task of mocks.afterTasks.splice(0)) await task();
  const events = text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
  return { response, text, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.afterTasks = [];
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VIDEO_RENDER_ENABLED", "1");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.after.mockImplementation((task: () => Promise<void>) => {
    mocks.afterTasks.push(task);
  });
  mocks.isNarrationAvailable.mockResolvedValue(true);
  mocks.readVideoArtifact.mockResolvedValue(null);
  mocks.tryVideoLock.mockResolvedValue(mocks.releaseLock);
  mocks.tryPaidVideoRun.mockResolvedValue(mocks.releaseRun);
  mocks.remakePosterRemotely.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type RunParams = {
  onEvent: (event: unknown) => void;
  onPaidWork: () => Promise<void>;
  choosePlanner: (repository: { stars: number }) => Promise<unknown>;
};

/** A run that reads the repository, then (maybe) starts paid work, then fails. */
function failAfter(error: Error, { paid }: { paid: boolean }) {
  mocks.generateExplainerVideo.mockImplementation(async (params: RunParams) => {
    params.onEvent({ status: "reading", elapsedMs: 0 });
    await params.choosePlanner({ stars: 1 });
    if (paid) {
      params.onEvent({ status: "planning", elapsedMs: 1 });
      await params.onPaidWork();
    }
    throw error;
  });
}

/** A run that makes its video. */
function succeed() {
  mocks.generateExplainerVideo.mockImplementation(async (params: RunParams) => {
    params.onEvent({ status: "planning", elapsedMs: 1 });
    await params.onPaidWork();
    return { repository: "acme/demo", createdAt: "2026-09-25T00:00:00.000Z" };
  });
}

describe("POST /api/video/generate", () => {
  it("refuses a Windows device name as owner or repo before any work", async () => {
    const names: Array<[string, string]> = [
      ["con", "demo"],
      ["acme", "NUL"],
      ["acme", "com1"],
      ["Lpt9", "demo"],
      ["acme", "aux.js"],
      ["acme", "prn.txt"],
    ];

    for (const [username, repo] of names) {
      mocks.readVideoArtifact.mockClear();
      const { response, text } = await run(
        request(null, {}, { username, repo }),
      );

      expect(response.status, `${username}/${repo}`).toBe(400);
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/reserved|cannot be stored/i) as string,
      });
      expect(mocks.readVideoArtifact).not.toHaveBeenCalled();
      expect(mocks.tryVideoLock).not.toHaveBeenCalled();
      expect(mocks.tryPaidVideoRun).not.toHaveBeenCalled();
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    }
  });

  it("does not need a visitor cookie and sets none", async () => {
    succeed();

    const { response, events } = await run(request(null));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(events.at(-1)).toMatchObject({ status: "complete" });
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("ignores a stale visitor cookie from an earlier release", async () => {
    succeed();

    const { response, events } = await run(
      request("gd_visitor=0b6f3a52-6a1f-4a8e-9a3c-2f0d7c1e5b44"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(events.at(-1)).toMatchObject({ status: "complete" });
  });

  // Phase 4 decision (1), the Professor, 2026-09-30: the pause switch is gone,
  // but the safeguards stay for the operator. The voice-credit check and the
  // "already made" check apply to every signed-in caller; replacing a video
  // needs `regenerate: true`.
  describe("the voice-credit check applies to the operator", () => {
    it("answers 503 with the voice pause message before any paid work", async () => {
      mocks.isNarrationAvailable.mockResolvedValue(false);

      const { response, text } = await run();

      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/paused for a few minutes/) as string,
      });
      expect(mocks.isNarrationAvailable).toHaveBeenCalled();
      expect(mocks.tryVideoLock).not.toHaveBeenCalled();
      expect(mocks.tryPaidVideoRun).not.toHaveBeenCalled();
      expect(mocks.choosePlanner).not.toHaveBeenCalled();
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("also refuses outside production, where no lock is taken", async () => {
      vi.stubEnv("NODE_ENV", "development");
      mocks.isNarrationAvailable.mockResolvedValue(false);

      const { response } = await run();

      expect(response.status).toBe(503);
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("refuses a regeneration too, so no script is paid for that cannot be voiced", async () => {
      mocks.isNarrationAvailable.mockResolvedValue(false);
      mocks.readVideoArtifact.mockResolvedValue({ repository: "acme/demo" });

      const { response } = await run(
        request(null, {}, { username: "acme", repo: "demo", regenerate: true }),
      );

      expect(response.status).toBe(503);
      expect(mocks.tryVideoLock).not.toHaveBeenCalled();
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("lets a run start while the narrator is available", async () => {
      succeed();

      const { response, events } = await run();

      expect(response.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ status: "complete" });
    });
  });

  describe("replacing an existing video needs an explicit regenerate", () => {
    const existing = { repository: "acme/demo" };

    it("answers 409 exists when a video exists and regenerate is absent", async () => {
      mocks.readVideoArtifact.mockResolvedValue(existing);

      const { response, text } = await run();

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toMatchObject({ ok: false, reason: "exists" });
      expect(mocks.tryVideoLock).not.toHaveBeenCalled();
      expect(mocks.tryPaidVideoRun).not.toHaveBeenCalled();
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("answers 409 exists when regenerate is false", async () => {
      mocks.readVideoArtifact.mockResolvedValue(existing);

      const { response, text } = await run(
        request(
          null,
          {},
          { username: "acme", repo: "demo", regenerate: false },
        ),
      );

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toMatchObject({ reason: "exists" });
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("replaces the video when regenerate is true", async () => {
      mocks.readVideoArtifact.mockResolvedValue(existing);
      succeed();

      const { response, events } = await run(
        request(null, {}, { username: "acme", repo: "demo", regenerate: true }),
      );

      expect(response.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ status: "complete" });
      expect(mocks.tryVideoLock).toHaveBeenCalledTimes(1);
      expect(mocks.tryPaidVideoRun).toHaveBeenCalledWith({
        operator: true,
        ttlMs: expect.any(Number),
      });
    });

    it("makes a first video whether or not regenerate is sent", async () => {
      succeed();

      for (const body of [
        { username: "acme", repo: "demo" },
        { username: "acme", repo: "demo", regenerate: true },
        { username: "acme", repo: "demo", regenerate: false },
      ]) {
        const { response, events } = await run(request(null, {}, body));

        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(events.at(-1)).toMatchObject({ status: "complete" });
      }
    });

    it("still answers 409 generating when the lock is held, even with regenerate", async () => {
      mocks.readVideoArtifact.mockResolvedValue(existing);
      mocks.tryVideoLock.mockResolvedValue(null);

      const { response, text } = await run(
        request(null, {}, { username: "acme", repo: "demo", regenerate: true }),
      );

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toMatchObject({ reason: "generating" });
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("still turns the run away when the paid-run cap is full, even with regenerate", async () => {
      mocks.readVideoArtifact.mockResolvedValue(existing);
      mocks.tryPaidVideoRun.mockResolvedValue(null);
      failAfter(new Error("unreachable"), { paid: true });

      const { events } = await run(
        request(null, {}, { username: "acme", repo: "demo", regenerate: true }),
      );

      expect(events.at(-1)).toMatchObject({
        status: "error",
        error: expect.stringMatching(/Lots of videos/) as string,
      });
      expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    });

    it("checks again under the lock: a video stored meanwhile answers 409 exists and frees the lock", async () => {
      mocks.readVideoArtifact
        .mockResolvedValueOnce(null)
        .mockResolvedValue(existing);

      const { response, text } = await run();

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toMatchObject({ reason: "exists" });
      expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });

    it("does not check under the lock when regenerate is true", async () => {
      mocks.readVideoArtifact
        .mockResolvedValueOnce(null)
        .mockResolvedValue(existing);
      succeed();

      const { response, events } = await run(
        request(null, {}, { username: "acme", repo: "demo", regenerate: true }),
      );

      expect(response.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ status: "complete" });
    });

    it("starts nothing when the stored video cannot be read", async () => {
      mocks.readVideoArtifact.mockRejectedValue(new Error("disk unreadable"));

      const { response } = await run();

      expect(response.status).toBe(503);
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });
  });

  describe("the request body", () => {
    it.each([
      { regenerate: "true" },
      { regenerate: 1 },
      { regenerate: null },
      { regenerate: { now: true } },
      { replace: true },
    ])("rejects %j with 400 before any work", async (extra) => {
      const { response } = await run(
        request(null, {}, { username: "acme", repo: "demo", ...extra }),
      );

      expect(response.status).toBe(400);
      expect(mocks.readVideoArtifact).not.toHaveBeenCalled();
      expect(mocks.isNarrationAvailable).not.toHaveBeenCalled();
      expect(mocks.tryVideoLock).not.toHaveBeenCalled();
      expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    });
  });

  it("has no audience, device or country refusal", async () => {
    succeed();

    for (const country of ["IN", "BR", "PK", "US"]) {
      const { response, events } = await run(
        request(null, {
          "x-vercel-ip-country": country,
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile",
        }),
      );

      expect(response.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ status: "complete" });
    }

    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("has no daily, per-person, per-connection or attempt budget", async () => {
    succeed();

    for (let attempt = 0; attempt < 5; attempt++) {
      const { response, events } = await run();

      expect(response.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ status: "complete" });
    }

    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("answers 409 generating when the repository's lock is already held", async () => {
    mocks.tryVideoLock.mockResolvedValue(null);
    const { response, text } = await run();
    expect(response.status).toBe(409);
    expect(JSON.parse(text)).toMatchObject({ reason: "generating" });
    expect(mocks.generateExplainerVideo).not.toHaveBeenCalled();
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("picks the planner from the stars and the operator flag alone", async () => {
    mocks.generateExplainerVideo.mockImplementation(
      async (params: RunParams) => {
        await params.choosePlanner({ stars: 42 });
        await params.onPaidWork();
        return { repository: "acme/demo" };
      },
    );

    await run();

    expect(mocks.choosePlanner).toHaveBeenCalledTimes(1);

    const given = mocks.choosePlanner.mock.calls[0]![0] as Record<
      string,
      unknown
    >;

    expect(given).toMatchObject({ operator: true, stars: 42 });
    expect(given).not.toHaveProperty("priority");
    expect(given).not.toHaveProperty("standardOnly");
    expect(given).not.toHaveProperty("takePremium");
  });

  it("reports a failure that happened before any model was paid, and releases the lock", async () => {
    failAfter(new Error("GitHub timed out"), { paid: false });
    const { events } = await run();
    expect(events.at(-1)).toMatchObject({ status: "error", retryable: true });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    // No model was called, so no paid-run place was ever taken.
    expect(mocks.tryPaidVideoRun).not.toHaveBeenCalled();
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("no longer tells anyone a failed try counted toward today's free videos", async () => {
    failAfter(new Error("model down"), { paid: true });
    const { events } = await run();
    expect(events.at(-1)).toMatchObject({ status: "error" });
    expect(String(events.at(-1)!.error)).not.toMatch(/counted toward today/);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseRun).toHaveBeenCalledTimes(1);
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("offers the operator a retry after a paid failure", async () => {
    failAfter(new Error("model down"), { paid: true });
    const { events } = await run();
    expect(events.at(-1)).toMatchObject({ status: "error", retryable: true });
  });

  it("tells the viewer to retry when the narrator runs out of credit mid-run", async () => {
    failAfter(new VoiceUnavailableError("The voice balance has run out."), {
      paid: true,
    });
    const { events } = await run();
    expect(events.at(-1)).toEqual({
      status: "error",
      error:
        "The narrator is unavailable right now. Try again in a few minutes.",
      retryable: true,
    });
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("takes a paid-run place only when paid work starts, and turns the run away when they are full", async () => {
    mocks.tryPaidVideoRun.mockResolvedValue(null);
    failAfter(new Error("unreachable"), { paid: true });
    const { response, events } = await run();
    expect(response.status).toBe(200);
    expect(events.at(-1)).toEqual({
      status: "error",
      error:
        "Lots of videos are being made right now. Try again in a few minutes.",
      retryable: true,
    });
    expect(mocks.removedDependency).not.toHaveBeenCalled();
    expect(mocks.releaseRun).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not offer a retry after a refusal or for a private repository", async () => {
    failAfter(new VideoRefusalError("declined"), { paid: true });
    expect((await run()).events.at(-1)).toMatchObject({
      status: "error",
      retryable: false,
    });
    failAfter(new VideoInputError("Public repositories only."), {
      paid: false,
    });
    expect((await run()).events.at(-1)).toEqual({
      status: "error",
      error: "Public repositories only.",
      retryable: false,
    });
  });

  it("passes the run a deadline, completes the stream, then makes the poster remotely", async () => {
    mocks.generateExplainerVideo.mockImplementation(
      async (params: RunParams & { signal: AbortSignal }) => {
        expect(params.signal).toBeInstanceOf(AbortSignal);
        expect(params.signal.aborted).toBe(false);
        await params.onPaidWork();
        return { repository: "acme/demo" };
      },
    );
    const { events } = await run();
    expect(events.at(-1)).toMatchObject({ status: "complete" });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseRun).toHaveBeenCalledTimes(1);
    // The lock and paid-run place are released before the poster is made.
    expect(mocks.releaseLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remakePosterRemotely.mock.invocationCallOrder[0]!,
    );
    expect(mocks.remakePosterRemotely).toHaveBeenCalledWith(
      { repository: "acme/demo" },
      "https://gitdiagram.com",
      { timeoutMs: expect.any(Number) },
    );
    const { timeoutMs } = mocks.remakePosterRemotely.mock.calls[0]![2];
    expect(timeoutMs).toBeLessThanOrEqual(285_000);
    // Once for the new video, once more for its poster.
    expect(mocks.refreshVideoPages).toHaveBeenCalledTimes(2);
  });

  it("makes no poster, and logs why, when MP4 rendering is turned off", async () => {
    vi.stubEnv("VIDEO_RENDER_ENABLED", "0");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.generateExplainerVideo.mockImplementation(
      async (params: RunParams) => {
        await params.onPaidWork();
        return { repository: "acme/demo" };
      },
    );
    const { events } = await run();
    expect(events.at(-1)).toMatchObject({ status: "complete" });
    expect(mocks.remakePosterRemotely).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("video.poster.remote_failed"),
    );
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        event: "video.poster.render_disabled",
        repository: "acme/demo",
      }),
    );
    // The pages still point at the new video.
    expect(mocks.refreshVideoPages).toHaveBeenCalledTimes(1);
  });

  it("skips the poster when too little of the function's time is left", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    mocks.generateExplainerVideo.mockImplementation(async () => {
      vi.setSystemTime(start + 270_000);
      return { repository: "acme/demo" };
    });
    const { events } = await run();
    expect(events.at(-1)).toMatchObject({ status: "complete" });
    expect(mocks.remakePosterRemotely).not.toHaveBeenCalled();
    // The pages still point at the new video.
    expect(mocks.refreshVideoPages).toHaveBeenCalledTimes(1);
  });
});

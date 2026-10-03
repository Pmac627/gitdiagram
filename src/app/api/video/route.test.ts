// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isVideoAdmin: vi.fn(),
  readVideoArtifact: vi.fn(),
  isVideoLockHeld: vi.fn(),
  removedDependency: vi.fn(),
  isNarrationAvailable: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("~/server/explainer/config", () => ({
  canGenerateVideos: () => true,
  isVideoExplainerEnabled: () => true,
  isVideoRenderEnabled: () => process.env.VIDEO_RENDER_ENABLED?.trim() === "1",
}));
vi.mock("~/server/explainer/limits", () => ({
  generationLockName: (u: string, r: string) => `generate:${u}/${r}`,
  isVideoAdmin: mocks.isVideoAdmin,
  isVideoLockHeld: mocks.isVideoLockHeld,
  // Removed in Phase 3: no per-person or per-connection budget is read.
  videoLimitReached: mocks.removedDependency,
}));
vi.mock("~/server/explainer/narration", () => ({
  isNarrationAvailable: mocks.isNarrationAvailable,
}));
vi.mock("~/server/explainer/store", () => ({
  readVideoArtifact: mocks.readVideoArtifact,
}));

import { registerOperatorSession } from "~/server/auth/test-session";

import { GET } from "./route";

const session = registerOperatorSession();

const get = (headers: Record<string, string> = {}) =>
  GET(
    new Request("https://gitdiagram.com/api/video?username=acme&repo=demo", {
      headers: { ...session.headers, ...headers },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  mocks.isVideoAdmin.mockResolvedValue(false);
  mocks.readVideoArtifact.mockResolvedValue(null);
  mocks.isVideoLockHeld.mockResolvedValue(false);
  mocks.isNarrationAvailable.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/video renderEnabled", () => {
  it.each([
    ["no video", null],
    ["a stored video", { repository: "acme/demo" }],
  ])("is false for %s when MP4 rendering is off", async (_name, stored) => {
    vi.stubEnv("VIDEO_RENDER_ENABLED", "");
    mocks.readVideoArtifact.mockResolvedValue(stored);
    expect(await (await get()).json()).toMatchObject({ renderEnabled: false });
  });

  it.each([
    ["no video", null],
    ["a stored video", { repository: "acme/demo" }],
  ])("is true for %s when VIDEO_RENDER_ENABLED=1", async (_name, stored) => {
    vi.stubEnv("VIDEO_RENDER_ENABLED", "1");
    mocks.readVideoArtifact.mockResolvedValue(stored);
    expect(await (await get()).json()).toMatchObject({ renderEnabled: true });
  });
});

describe("GET /api/video", () => {
  it("says when a video is being made, uncached", async () => {
    mocks.isVideoLockHeld.mockResolvedValue(true);
    const response = await get();
    expect(await response.json()).toMatchObject({
      video: null,
      generating: true,
      canGenerate: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.isVideoLockHeld).toHaveBeenCalledWith("generate:acme/demo");
  });

  it("sets no visitor cookie, on a fresh or a cached answer", async () => {
    const fresh = await get();
    expect(fresh.headers.get("set-cookie")).toBeNull();
    expect(fresh.headers.get("cache-control")).toBe("no-store");

    mocks.readVideoArtifact.mockResolvedValue({ repository: "acme/demo" });
    const cached = await get();
    expect(cached.headers.get("set-cookie")).toBeNull();
  });

  it("puts no CDN cache tag or CDN cache header on a stored video's answer", async () => {
    mocks.readVideoArtifact.mockResolvedValue({ repository: "acme/demo" });

    const response = await get();
    const names = [...response.headers.keys()].map((name) =>
      name.toLowerCase(),
    );

    expect(names).not.toContain("vercel-cache-tag");
    expect(names).not.toContain("vercel-cdn-cache-control");
    expect(names).not.toContain("cdn-cache-control");
  });

  it("never lets a shared cache keep a stored video's answer", async () => {
    mocks.readVideoArtifact.mockResolvedValue({ repository: "acme/demo" });

    const cacheControl = (await get()).headers.get("cache-control") ?? "";

    expect(cacheControl).not.toMatch(/\bpublic\b/);
    expect(cacheControl).not.toContain("s-maxage");
    expect(cacheControl).toMatch(/private|no-store/);
  });

  it("offers a new video without a visitor id, a budget read or a device split", async () => {
    const body = (await (
      await get({ "x-forwarded-for": "203.0.113.9" })
    ).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ canGenerate: true, paused: null });
    expect(body).not.toHaveProperty("anyDevice");
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("ignores the caller's country: geolocation headers change nothing", async () => {
    for (const country of ["PK", "US", "IN", "FR"]) {
      expect(
        await (await get({ "x-vercel-ip-country": country })).json(),
      ).toMatchObject({ canGenerate: true, paused: null });
    }
  });

  it("stays available in production on a phone", async () => {
    expect(
      await (
        await get({
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
        })
      ).json(),
    ).toMatchObject({ canGenerate: true, paused: null });
  });

  it("reports a paused narrator as the reason", async () => {
    mocks.isNarrationAvailable.mockResolvedValue(false);
    expect(await (await get()).json()).toMatchObject({
      canGenerate: false,
      paused: "limit",
    });
  });

  // Phase 4 decision (1): the voice-credit check applies to the operator, so
  // the panel must not offer a video the generate route would refuse.
  it("reports a paused narrator to the operator too", async () => {
    mocks.isVideoAdmin.mockResolvedValue(true);
    mocks.isNarrationAvailable.mockResolvedValue(false);

    expect(await (await get()).json()).toMatchObject({
      canGenerate: false,
      paused: "limit",
    });
  });

  it("offers the operator a new video while the narrator is available", async () => {
    mocks.isVideoAdmin.mockResolvedValue(true);

    expect(await (await get()).json()).toMatchObject({
      canGenerate: true,
      paused: null,
    });
  });

  it("offers no new video when the narrator's state cannot be read", async () => {
    mocks.isNarrationAvailable.mockRejectedValue(new Error("db down"));

    expect(await (await get()).json()).toMatchObject({
      canGenerate: false,
      paused: "limit",
    });
  });
});

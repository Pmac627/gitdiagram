import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readVideoArtifact: vi.fn(),
  hasRender: vi.fn(),
  writeRender: vi.fn(),
  renderMp4InSegments: vi.fn(),
  remakePosterRemotely: vi.fn(),
  removedDependency: vi.fn(),
  tryVideoLock: vi.fn(),
  isTrustedVideoCaller: vi.fn(),
  refreshVideoPages: vi.fn(),
  release: vi.fn(),
  after: [] as Array<() => unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({
  after: (task: () => unknown) => mocks.after.push(task),
}));
vi.mock("~/server/explainer/config", () => ({
  isVideoExplainerEnabled: () => true,
  isVideoRenderEnabled: () => process.env.VIDEO_RENDER_ENABLED?.trim() === "1",
}));
vi.mock("~/server/explainer/cache", () => ({
  refreshVideoPages: mocks.refreshVideoPages,
}));
vi.mock("~/server/explainer/limits", () => ({
  isTrustedVideoCaller: mocks.isTrustedVideoCaller,
  // Removed in Phase 3: MP4 renders have no daily budget. The tripwires fail
  // any test where the route still reaches for one.
  reserveRenderSlot: mocks.removedDependency,
  renderLimitMessage: mocks.removedDependency,
  tryVideoLock: mocks.tryVideoLock,
}));
vi.mock("~/server/explainer/segments", () => ({
  isStaleRender: (error: unknown) =>
    error instanceof Error && error.message === "stale",
  RENDER_TOTAL_DEADLINE_MS: 780_000,
  renderMp4InSegments: mocks.renderMp4InSegments,
  remakePosterRemotely: mocks.remakePosterRemotely,
}));
vi.mock("~/server/explainer/store", () => ({
  hasRender: mocks.hasRender,
  readVideoArtifact: mocks.readVideoArtifact,
  writeRender: mocks.writeRender,
}));

import { registerOperatorSession } from "~/server/auth/test-session";
import { POST } from "./route";

const session = registerOperatorSession();

const createdAt = "2026-09-24T08:06:45.297Z";
const artifact = {
  createdAt,
  repository: "acme/widget",
  meta: { owner: "acme", repo: "widget" },
};

const savedEnv = {
  PORT: process.env.PORT,
  VERCEL: process.env.VERCEL,
  VIDEO_RENDER_ENABLED: process.env.VIDEO_RENDER_ENABLED,
  VIDEO_INTERNAL_ORIGIN: process.env.VIDEO_INTERNAL_ORIGIN,
};

function request(body: Record<string, unknown>) {
  return new Request("https://gitdiagram.com/api/video/render", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://gitdiagram.com",
      "Sec-Fetch-Site": "same-origin",
      ...session.headers,
    },
    body: JSON.stringify({ username: "acme", repo: "widget", ...body }),
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  process.env.VIDEO_RENDER_ENABLED = "1";
  mocks.after.length = 0;
  mocks.readVideoArtifact.mockResolvedValue(artifact);
  mocks.hasRender.mockResolvedValue(false);
  mocks.isTrustedVideoCaller.mockReturnValue(false);
  mocks.tryVideoLock.mockResolvedValue(mocks.release);
  mocks.renderMp4InSegments.mockResolvedValue(Buffer.from("mp4"));
  mocks.writeRender.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.clearAllMocks();
});

describe("POST /api/video/render", () => {
  it.each(["landscape", "vertical", "poster"])(
    "answers 501 for %s when MP4 rendering is turned off, before any work",
    async (format) => {
      delete process.env.VIDEO_RENDER_ENABLED;
      mocks.isTrustedVideoCaller.mockReturnValue(true);
      const response = await POST(request({ format, v: createdAt }));
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        ok: false,
        error: "MP4 rendering is turned off on this server.",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.readVideoArtifact).not.toHaveBeenCalled();
      expect(mocks.hasRender).not.toHaveBeenCalled();
      expect(mocks.tryVideoLock).not.toHaveBeenCalled();
      expect(mocks.renderMp4InSegments).not.toHaveBeenCalled();
      expect(mocks.remakePosterRemotely).not.toHaveBeenCalled();
    },
  );

  it("tells a viewer with an older version open to reload, spending nothing", async () => {
    const response = await POST(
      request({ format: "landscape", v: "2026-09-01T00:00:00.000Z" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ stale: true });
    expect(mocks.removedDependency).not.toHaveBeenCalled();
    expect(mocks.tryVideoLock).not.toHaveBeenCalled();
  });

  it("renders and stores the MP4 of the version the viewer has open", async () => {
    const response = await POST(request({ format: "landscape", v: createdAt }));
    expect(await response.text()).toContain('"status":"complete"');
    expect(mocks.writeRender).toHaveBeenCalledWith(
      artifact,
      "landscape.mp4",
      Buffer.from("mp4"),
    );
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("sets no visitor cookie and needs none", async () => {
    const response = await POST(request({ format: "landscape", v: createdAt }));
    await response.text();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("has no daily, per-person or per-connection render budget", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await POST(
        request({ format: "landscape", v: createdAt }),
      );
      expect(await response.text()).toContain('"status":"complete"');
    }
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("serves an MP4 another render stored while it waited for the lock", async () => {
    mocks.hasRender.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const response = await POST(request({ format: "vertical", v: createdAt }));
    expect(await response.text()).toContain('"status":"complete"');
    expect(mocks.renderMp4InSegments).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });

  it("drops an MP4 whose video was regenerated while it rendered", async () => {
    mocks.readVideoArtifact
      .mockResolvedValueOnce(artifact)
      .mockResolvedValueOnce({
        ...artifact,
        createdAt: "2026-09-25T00:00:00.000Z",
      });
    const response = await POST(request({ format: "landscape", v: createdAt }));
    expect(await response.text()).toContain("Reload the page");
    expect(mocks.writeRender).not.toHaveBeenCalled();
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("tells the viewer to reload when a segment finds the video replaced", async () => {
    mocks.renderMp4InSegments.mockImplementation(
      async ({ onStarted }: { onStarted: () => void }) => {
        onStarted();
        throw new Error("stale");
      },
    );
    const response = await POST(request({ format: "landscape", v: createdAt }));
    const text = await response.text();
    expect(text).toContain("Reload the page");
    expect(text).not.toContain("could not be made");
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("reports a render that failed before any segment ran, and releases the lock", async () => {
    mocks.renderMp4InSegments.mockRejectedValue(new Error("no secret"));
    const response = await POST(request({ format: "landscape", v: createdAt }));
    expect(await response.text()).toContain("could not be made");
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("reports a failed store after segments ran, and releases the lock", async () => {
    mocks.renderMp4InSegments.mockImplementation(
      async ({ onStarted }: { onStarted: () => void }) => {
        onStarted();
        return Buffer.from("mp4");
      },
    );
    mocks.writeRender.mockRejectedValueOnce(new Error("R2 down"));
    const response = await POST(request({ format: "landscape", v: createdAt }));
    expect(await response.text()).toContain("could not be made");
    expect(mocks.release).toHaveBeenCalled();
  });

  it("gives the render one deadline and calls itself back over loopback in a container", async () => {
    Object.assign(process.env, { PORT: "3000" });
    delete process.env.VERCEL;
    delete process.env.VIDEO_INTERNAL_ORIGIN;
    await (await POST(request({ format: "landscape", v: createdAt }))).text();
    const params = mocks.renderMp4InSegments.mock.calls[0]![0] as {
      origin: string;
      signal: AbortSignal;
    };
    expect(params.origin).toBe("http://127.0.0.1:3000");
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });

  it("remakes a poster on a render instance and refreshes its pages", async () => {
    mocks.isTrustedVideoCaller.mockReturnValue(true);
    mocks.remakePosterRemotely.mockResolvedValue(true);
    const response = await POST(request({ format: "poster" }));
    expect(await response.text()).toContain('"status":"complete"');
    expect(mocks.refreshVideoPages).toHaveBeenCalledWith("acme", "widget");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./planner", () => ({
  hasKeyFor: () => true,
  plannerModels: () => [],
}));
vi.mock("./voice", () => ({ isVoiceConfigured: () => true }));

import { isVideoRenderEnabled } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isVideoRenderEnabled", () => {
  it("is off when VIDEO_RENDER_ENABLED is unset", () => {
    delete process.env.VIDEO_RENDER_ENABLED;
    expect(isVideoRenderEnabled()).toBe(false);
  });

  it("is on only for the value 1, ignoring surrounding whitespace", () => {
    vi.stubEnv("VIDEO_RENDER_ENABLED", "1");
    expect(isVideoRenderEnabled()).toBe(true);
    vi.stubEnv("VIDEO_RENDER_ENABLED", " 1 \r\n");
    expect(isVideoRenderEnabled()).toBe(true);
  });

  it.each(["0", "", "true", "yes", "11", "on"])("is off for %j", (value) => {
    vi.stubEnv("VIDEO_RENDER_ENABLED", value);
    expect(isVideoRenderEnabled()).toBe(false);
  });
});

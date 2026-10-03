import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { canGenerateVideos } from "./config";
import { choosePlanner, premiumPlanner } from "./planner";

const OPUS = { model: "claude-opus-5-5", effort: "low" };
const SOL = { model: "gpt-6-sol", effort: "medium" };
// Opus writes the script, Sol designs the scenes.
const STANDARD = { ...OPUS, designer: SOL };
// With VIDEO_PREMIUM_OPUS_DESIGNS=1 (set by choose(), so the routing shows):
// Opus writes and designs; Sol takes over both if Opus fails.
const PREMIUM = { ...OPUS, fallback: SOL };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function choose(overrides: Partial<Parameters<typeof choosePlanner>[0]> = {}) {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("VIDEO_PREMIUM_OPUS_DESIGNS", "1");
  return choosePlanner({
    operator: false,
    stars: 100,
    ...overrides,
  });
}

describe("choosing the video planner", () => {
  it("gives everyone else the Opus-and-Sol planner", async () => {
    const choice = await choose();
    expect(choice.planner).toEqual(STANDARD);
    expect(choice).not.toHaveProperty("refund");
  });

  it("makes popular repositories and the operator's videos with Opus", async () => {
    expect((await choose({ stars: 10_000 })).planner).toEqual(PREMIUM);
    expect((await choose({ operator: true })).planner).toEqual(PREMIUM);
  });

  it("uses the star threshold from VIDEO_PREMIUM_MIN_STARS", async () => {
    vi.stubEnv("VIDEO_PREMIUM_MIN_STARS", "500");
    expect((await choose({ stars: 499 })).planner).toEqual(STANDARD);
    expect((await choose({ stars: 500 })).planner).toEqual(PREMIUM);
  });

  it("has no priority-visitor premium path: a stale priority flag changes nothing", async () => {
    const takePremium = vi.fn(async () => ({
      refund: vi.fn(async () => undefined),
    }));
    const choice = await choosePlanner({
      operator: false,
      stars: 100,
      priority: true,
      takePremium,
    } as never);

    expect(choice.planner).toEqual(STANDARD);
    expect(choice).not.toHaveProperty("refund");
    expect(takePremium).not.toHaveBeenCalled();
  });

  it("lets Sol write the standard script too when configured", async () => {
    vi.stubEnv("VIDEO_STANDARD_DIRECTOR_MODEL", "gpt-6-sol");
    expect((await choose()).planner).toEqual(SOL);
  });

  it("has Sol design premium films by default", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    expect(premiumPlanner()).toEqual(STANDARD);
  });

  it("gives Opus no stand-in without an OpenAI key", () => {
    vi.stubEnv("VIDEO_PREMIUM_OPUS_DESIGNS", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(premiumPlanner()).toEqual(OPUS);
  });

  it("lets Sol make premium films alone when it is the premium model", () => {
    vi.stubEnv("VIDEO_PLANNER_MODEL", "gpt-6-sol");
    expect(premiumPlanner()).toEqual({ ...SOL, effort: "low" });
  });
});

describe("whether videos can be made", () => {
  const keys = (anthropic: string, openai: string) => {
    vi.stubEnv("ANTHROPIC_API_KEY", anthropic);
    vi.stubEnv("OPENAI_API_KEY", openai);
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  };

  it("needs the key of every configured model's provider", () => {
    keys("sk-ant", "sk-test");
    expect(canGenerateVideos()).toBe(true);
    keys("", "sk-test");
    expect(canGenerateVideos()).toBe(false);
  });

  it("needs no Claude key when every model is a GPT", () => {
    keys("", "sk-test");
    vi.stubEnv("VIDEO_PLANNER_MODEL", "gpt-6-sol");
    vi.stubEnv("VIDEO_STANDARD_DIRECTOR_MODEL", "gpt-6-sol");
    expect(canGenerateVideos()).toBe(true);
  });
});

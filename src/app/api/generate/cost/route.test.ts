// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createGenerationProvider: vi.fn(),
  estimateCost: vi.fn(),
  getGithubData: vi.fn(),
  resolveRequestCredentials: vi.fn(),
  removedDependency: vi.fn(),
}));

vi.mock("~/server/ai/create-provider", () => ({
  createGenerationProvider: mocks.createGenerationProvider,
}));

// Phase 3 removed the infrastructure limiter and the complimentary gate. Any
// call is a failure, and the call is recorded so tests can assert none happened.
function removedDependency(module: string, member: string) {
  return () => {
    mocks.removedDependency(`${module}.${member}`);
    throw new Error(`removed dependency called: ${module}.${member}`);
  };
}

vi.mock("~/server/generate/rate-limit", () => ({
  consumeGenerationInfrastructureRateLimit: removedDependency(
    "rate-limit",
    "consumeGenerationInfrastructureRateLimit",
  ),
  getGenerationInfrastructureRateLimitMessage: removedDependency(
    "rate-limit",
    "getGenerationInfrastructureRateLimitMessage",
  ),
}));

vi.mock("~/server/generate/cost-estimate", () => ({
  estimateGenerationCost: mocks.estimateCost,
}));
vi.mock("~/server/generate/complimentary-gate", () => ({
  getComplimentaryModelMismatchMessage: removedDependency(
    "complimentary-gate",
    "getComplimentaryModelMismatchMessage",
  ),
  getComplimentaryProviderMismatchMessage: removedDependency(
    "complimentary-gate",
    "getComplimentaryProviderMismatchMessage",
  ),
  isComplimentaryGateEnabled: removedDependency(
    "complimentary-gate",
    "isComplimentaryGateEnabled",
  ),
  modelMatchesComplimentaryFamily: removedDependency(
    "complimentary-gate",
    "modelMatchesComplimentaryFamily",
  ),
}));
vi.mock("~/server/generate/github", () => ({
  getGithubData: mocks.getGithubData,
  REPOSITORY_TOO_LARGE_ERROR:
    "Repository is too large for analysis. Try a smaller repo.",
}));
vi.mock("~/server/generate/model-config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModel: vi.fn(() => "gpt-5.6-terra"),
  getProvider: vi.fn(() => "openai"),
  shouldUseExactInputTokenCount: vi.fn(() => true),
}));
vi.mock("~/server/http/request-credentials", () => ({
  resolveRequestCredentials: mocks.resolveRequestCredentials,
}));

import { POST } from "~/app/api/generate/cost/route";
import { registerOperatorSession } from "~/server/auth/test-session";
import { getModel, getProvider } from "~/server/generate/model-config";

const session = registerOperatorSession();

function request() {
  return new Request("https://gitdiagram.com/api/generate/cost", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://gitdiagram.com",
      "Sec-Fetch-Site": "same-origin",
      ...session.headers,
    },
    body: JSON.stringify({ username: "openai", repo: "openai-node" }),
  });
}

describe("POST /api/generate/cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getModel).mockReturnValue("gpt-5.6-terra");
    vi.mocked(getProvider).mockReturnValue("openai");
    mocks.createGenerationProvider.mockReturnValue({
      streamText: vi.fn(),
      parseStructured: vi.fn(),
    });
    mocks.resolveRequestCredentials.mockImplementation(
      async (
        _request: Request,
        {
          apiKey,
          githubPat,
        }: {
          apiKey?: string;
          githubPat?: string;
        },
      ) => ({ apiKey, githubPat }),
    );
    mocks.getGithubData.mockResolvedValue({
      defaultBranch: "main",
      fileTree: "src/index.ts",
      pathTypes: new Map([["src/index.ts", "blob"]]),
      readme: "# OpenAI Node",
      isPrivate: false,
      stargazerCount: 10,
    });
  });

  it("uses cookie credentials when the compatibility body fields are absent", async () => {
    mocks.resolveRequestCredentials.mockResolvedValueOnce({
      apiKey: "cookie-openai-key",
      githubPat: "cookie-github-pat",
    });
    mocks.estimateCost.mockResolvedValue({
      costSummary: { display: "$0.0100 USD" },
      pricingModel: "gpt-5.6-terra",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      pricing: {
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 2,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.resolveRequestCredentials).toHaveBeenCalledWith(
      expect.any(Request),
      { apiKey: undefined, githubPat: undefined },
    );
    expect(mocks.getGithubData).toHaveBeenCalledWith(
      "openai",
      "openai-node",
      "cookie-github-pat",
      expect.any(AbortSignal),
    );
    expect(mocks.estimateCost).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "cookie-openai-key" }),
    );
  });

  it("logs generate.cost.failed without the caller key, an env key or a GitHub token", async () => {
    const callerKey = "caller-key-3f9a7c21d8e5";
    const envKey = "env-openai-key-0002-plain";
    const githubToken = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv("OPENAI_API_KEY", envKey);
    mocks.resolveRequestCredentials.mockResolvedValueOnce({
      apiKey: callerKey,
      githubPat: githubToken,
    });
    mocks.estimateCost.mockRejectedValue(
      new Error(
        `Incorrect API key provided: ${callerKey}. Server key ${envKey}. ` +
          `GitHub: Bad credentials ${githubToken}. Authorization: Bearer ${githubToken}`,
      ),
    );

    try {
      const response = await POST(request());

      expect(response.status).toBe(500);

      const logged = errorSpy.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");

      expect(logged).toContain("generate.cost.failed");
      expect(logged).toContain("Incorrect API key provided");
      expect(logged).not.toContain(callerKey);
      expect(logged).not.toContain(envKey);
      expect(logged).not.toContain(githubToken);
    } finally {
      vi.unstubAllEnvs();
      errorSpy.mockRestore();
    }
  });

  it("rejects a cross-origin caller before touching GitHub", async () => {
    // Estimation runs the same GitHub ingestion as a real generation, so an
    // open endpoint drains the server's shared API budget.
    const crossOrigin = new Request(
      "https://gitdiagram.com/api/generate/cost",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
          ...session.headers,
        },
        body: JSON.stringify({ username: "openai", repo: "openai-node" }),
      },
    );

    const response = await POST(crossOrigin);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error_code: "CROSS_ORIGIN_FORBIDDEN",
    });
    expect(mocks.getGithubData).not.toHaveBeenCalled();
  });

  it("returns the estimate on the server key with no limiter or gate dependency", async () => {
    mocks.estimateCost.mockResolvedValue({
      costSummary: { display: "$0.0100 USD" },
      pricingModel: "gpt-5.6-terra",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cost: "$0.0100 USD",
      estimated_input_tokens: 100,
      estimated_output_tokens: 200,
    });
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("returns token estimates and n/a cost for an unknown local model", async () => {
    vi.mocked(getProvider).mockReturnValue("openai-compatible");
    vi.mocked(getModel).mockReturnValue("local/mistral-small");
    mocks.estimateCost.mockResolvedValue({
      costSummary: {
        kind: "estimate",
        approximate: true,
        amountUsd: null,
        display: "n/a",
        pricingModel: "local/mistral-small",
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      },
      pricingModel: "local/mistral-small",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      pricing: null,
      analysisPricing: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cost: "n/a",
      cost_summary: { amountUsd: null, display: "n/a" },
      estimated_input_tokens: 100,
      estimated_output_tokens: 200,
      pricing: null,
      analysis_pricing: null,
    });
    expect(mocks.estimateCost).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        model: "local/mistral-small",
      }),
    );
  });

  it("passes the selected provider instance to cost estimation", async () => {
    mocks.estimateCost.mockResolvedValue({
      costSummary: { display: "$0.0100 USD" },
      pricingModel: "gpt-5.6-terra",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.createGenerationProvider).toHaveBeenCalledWith({
      provider: "openai",
      apiKey: undefined,
    });
    expect(mocks.estimateCost).toHaveBeenCalledWith(
      expect.objectContaining({
        generationProvider:
          mocks.createGenerationProvider.mock.results[0]?.value,
      }),
    );
  });

  it("never answers 429 however many estimates one caller asks for", async () => {
    mocks.estimateCost.mockResolvedValue({
      costSummary: { display: "$0.0100 USD" },
      pricingModel: "gpt-5.6-terra",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await POST(request());

      expect(response.status).toBe(200);
    }

    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("estimates for a caller paying with their own key with no limiter dependency", async () => {
    mocks.resolveRequestCredentials.mockResolvedValueOnce({
      apiKey: "caller-owned-key",
    });
    mocks.estimateCost.mockResolvedValue({
      costSummary: { display: "$0.0100 USD" },
      pricingModel: "gpt-5.6-terra",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("does not echo raw upstream failure text to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getGithubData.mockRejectedValue(
      new Error('GitHub request failed (403): {"message":"rate limit"}'),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Failed to estimate generation cost. Please retry.",
    );
    expect(body.error).not.toContain("rate limit");
  });

  it("still surfaces the actionable repository errors verbatim", async () => {
    mocks.getGithubData.mockRejectedValue(new Error("Repository not found."));

    const response = await POST(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("GitHub access"),
      error_code: "REPOSITORY_NOT_FOUND",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the route deadline abort to a 504 response", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    mocks.estimateCost.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const responsePromise = POST(request());
    deadline.abort(new DOMException("Cost deadline exceeded", "TimeoutError"));
    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Cost estimation timed out. Please retry.",
      error_code: "GENERATION_TIMEOUT",
    });
  });
});

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as StreamFinalization from "~/server/generate/stream-finalization";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createGenerationProvider: vi.fn(),
  providerStreamText: vi.fn(),
  providerParseStructured: vi.fn(),
  removedDependency: vi.fn(),
  clearFailureSummary: vi.fn(),
  estimateCost: vi.fn(),
  finalizeStream: vi.fn(),
  generateStructuredOutput: vi.fn(),
  getGithubData: vi.fn(),
  getModel: vi.fn(),
  persistAudit: vi.fn(),
  registerActiveGeneration: vi.fn(),
  resolveRequestCredentials: vi.fn(),
  saveDiagram: vi.fn(),
  startCancellationPolling: vi.fn(),
  stopCancellationPolling: vi.fn(),
  streamCompletion: vi.fn(),
  unregisterActiveGeneration: vi.fn(),
  writePublicPreview: vi.fn(),
  afterCallback: undefined as undefined | (() => Promise<void>),
  cancellationCallback: undefined as undefined | (() => void),
}));

vi.mock("~/server/ai/create-provider", () => ({
  createGenerationProvider: mocks.createGenerationProvider,
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("~/server/browse-index-cache", () => ({
  revalidateBrowseIndexCache: vi.fn(),
}));
vi.mock("~/server/storage/artifact-store", () => ({
  writePublicDiagramPreview: mocks.writePublicPreview,
}));
vi.mock("~/server/storage/diagram-state", () => ({
  clearSuccessfulDiagramFailureSummary: mocks.clearFailureSummary,
  persistTerminalSessionAudit: mocks.persistAudit,
  saveSuccessfulDiagramState: mocks.saveDiagram,
  updatePublicBrowseIndexForSuccessfulDiagram: vi.fn(),
}));
// Phase 3 removed the complimentary gate and the generation limiters. These
// tripwires fail any test where the route still reaches for them, and record
// the call so the admission test can name the offender.
function removedDependency(module: string, member: string) {
  return () => {
    mocks.removedDependency(`${module}.${member}`);
    throw new Error(`removed dependency called: ${module}.${member}`);
  };
}
vi.mock("~/server/generate/complimentary-gate", () => {
  const trip = (member: string) =>
    removedDependency("complimentary-gate", member);
  return {
    admitComplimentaryQuota: trip("admitComplimentaryQuota"),
    buildComplimentaryAdmissionTokens: trip(
      "buildComplimentaryAdmissionTokens",
    ),
    buildComplimentaryStageTokenEstimate: trip(
      "buildComplimentaryStageTokenEstimate",
    ),
    finalizeComplimentaryQuota: trip("finalizeComplimentaryQuota"),
    markComplimentaryQuotaStarted: trip("markComplimentaryQuotaStarted"),
    getComplimentaryDenialMessage: trip("getComplimentaryDenialMessage"),
    getComplimentaryModelMismatchMessage: trip(
      "getComplimentaryModelMismatchMessage",
    ),
    getComplimentaryProviderMismatchMessage: trip(
      "getComplimentaryProviderMismatchMessage",
    ),
    isComplimentaryGateEnabled: trip("isComplimentaryGateEnabled"),
    modelMatchesComplimentaryFamily: trip("modelMatchesComplimentaryFamily"),
    shouldApplyComplimentaryGate: trip("shouldApplyComplimentaryGate"),
  };
});
vi.mock("~/server/generate/stream-finalization", async (importOriginal) => {
  const actual = await importOriginal<typeof StreamFinalization>();
  mocks.finalizeStream.mockImplementation(actual.finalizeGenerationStream);
  return { ...actual, finalizeGenerationStream: mocks.finalizeStream };
});
vi.mock("~/server/generate/cost-estimate", () => ({
  estimateGenerationCost: mocks.estimateCost,
}));
vi.mock("~/server/generate/cancellation", () => ({
  registerActiveGeneration: mocks.registerActiveGeneration,
  startGenerationCancellationPolling: mocks.startCancellationPolling,
  unregisterActiveGeneration: mocks.unregisterActiveGeneration,
}));
vi.mock("~/server/generate/github", () => ({
  getGithubData: mocks.getGithubData,
  REPOSITORY_TOO_LARGE_ERROR:
    "Repository is too large for analysis. Try a smaller repo.",
}));
vi.mock("~/server/generate/model-config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModel: mocks.getModel,
  getProvider: vi.fn(() => "openai"),
  getProviderLabel: vi.fn(() => "OpenAI"),
  shouldUseExactInputTokenCount: vi.fn(() => true),
}));
vi.mock("~/server/http/request-credentials", () => ({
  resolveRequestCredentials: mocks.resolveRequestCredentials,
}));
vi.mock("~/server/generate/rate-limit", () => {
  const trip = (member: string) => removedDependency("rate-limit", member);
  return {
    consumeGenerationInfrastructureRateLimit: trip(
      "consumeGenerationInfrastructureRateLimit",
    ),
    consumeGenerationRateLimit: trip("consumeGenerationRateLimit"),
    getGenerationInfrastructureRateLimitMessage: trip(
      "getGenerationInfrastructureRateLimitMessage",
    ),
    getGenerationRateLimitMessage: trip("getGenerationRateLimitMessage"),
    refundGenerationInfrastructureRateLimit: trip(
      "refundGenerationInfrastructureRateLimit",
    ),
    refundGenerationRateLimit: trip("refundGenerationRateLimit"),
  };
});
vi.mock("~/server/storage/quota-store", () => {
  const trip = (member: string) => removedDependency("quota-store", member);
  return {
    checkQuotaInUpstash: trip("checkQuotaInUpstash"),
    commitQuotaUsageInUpstash: trip("commitQuotaUsageInUpstash"),
    markQuotaReservationStartedInUpstash: trip(
      "markQuotaReservationStartedInUpstash",
    ),
  };
});
import { POST } from "~/app/api/generate/stream/route";
import { registerOperatorSession } from "~/server/auth/test-session";
import { getProvider } from "~/server/generate/model-config";

const session = registerOperatorSession();

const estimateCostSummary = {
  kind: "estimate" as const,
  approximate: true,
  amountUsd: 0.01,
  display: "$0.0100 USD",
  pricingModel: "gpt-5.6-terra",
  usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
};

function request(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Request("https://gitdiagram.com/api/generate/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...session.headers,
      ...headers,
    },
    body: JSON.stringify({ username: "openai", repo: "openai-node", ...body }),
  });
}

function mockEstimate(explanationInputTokens: number) {
  mocks.estimateCost.mockResolvedValue({
    costSummary: estimateCostSummary,
    estimatedInputTokens: explanationInputTokens,
    estimatedOutputTokens: 200,
    pricingModel: "gpt-5.6-terra",
    pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
    explanationInputTokens,
    graphStaticInputTokens: 100,
    graphRepairStaticInputTokens: 100,
  });
}

function readSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .filter((message) => message.startsWith("data: "))
    .map((message) => JSON.parse(message.slice(6)) as Record<string, unknown>);
}

describe("POST /api/generate/stream", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerStreamText.mockImplementation((request) =>
      mocks.streamCompletion(request),
    );
    mocks.providerParseStructured.mockImplementation((request) =>
      mocks.generateStructuredOutput(request),
    );
    mocks.createGenerationProvider.mockReturnValue({
      streamText: mocks.providerStreamText,
      parseStructured: mocks.providerParseStructured,
    });
    mocks.generateStructuredOutput.mockReset();
    mocks.getModel.mockReturnValue("gpt-5.6-terra");
    vi.mocked(getProvider).mockReturnValue("openai");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getGithubData.mockResolvedValue({
      defaultBranch: "main",
      fileTree: "src/index.ts",
      pathTypes: new Map([["src/index.ts", "blob"]]),
      readme: "# OpenAI Node",
      isPrivate: false,
      stargazerCount: 10,
    });
    mocks.persistAudit.mockResolvedValue(undefined);
    mocks.clearFailureSummary.mockResolvedValue(undefined);
    mocks.saveDiagram.mockResolvedValue(true);
    mocks.afterCallback = undefined;
    mocks.after.mockImplementation((callback: () => Promise<void>) => {
      mocks.afterCallback = callback;
    });
    mocks.registerActiveGeneration.mockResolvedValue(true);
    mocks.resolveRequestCredentials.mockImplementation(
      async (
        _request: Request,
        explicit: { apiKey?: string; githubPat?: string },
      ) => explicit,
    );
    mocks.unregisterActiveGeneration.mockResolvedValue(undefined);
    mocks.writePublicPreview.mockResolvedValue(true);
    mocks.cancellationCallback = undefined;
    mocks.startCancellationPolling.mockImplementation(
      ({ onCancelled }: { onCancelled: () => void }) => {
        mocks.cancellationCallback = onCancelled;
        return mocks.stopCancellationPolling;
      },
    );
  });

  it("keeps padding disabled by default in a local production run", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSE_FLUSH_PAD_BYTES", undefined);
    mockEstimate(1_000);
    mocks.streamCompletion.mockRejectedValue(new Error("upstream exploded"));

    const body = await (await POST(request())).text();

    expect(body).toContain(": connected");
    expect(body).not.toMatch(/: {100,}\n\n/);
  });

  it("rejects an oversized padding setting before admission", async () => {
    vi.stubEnv("SSE_FLUSH_PAD_BYTES", "999999");

    await expect(POST(request())).rejects.toThrow(
      "SSE_FLUSH_PAD_BYTES must be an integer from 0 to 65536.",
    );
    expect(mocks.registerActiveGeneration).not.toHaveBeenCalled();
  });

  it("admits a same-origin request on the server key with no quota or limiter dependency", async () => {
    mockEstimate(1_000);
    mocks.streamCompletion.mockRejectedValue(new Error("upstream exploded"));

    const response = await POST(
      request({}, { "x-forwarded-for": "203.0.113.7" }),
    );
    const body = await response.text();
    await mocks.afterCallback?.();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-generation-session-id")).toBeTruthy();
    expect(mocks.getGithubData).toHaveBeenCalledTimes(1);
    expect(mocks.streamCompletion).toHaveBeenCalledTimes(1);
    expect(body).not.toContain("RATE_LIMITED");
    expect(body).not.toContain("DAILY_FREE_TOKEN_LIMIT_REACHED");
    expect(body).not.toContain("API_KEY_REQUIRED");
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("never answers 429 however many requests one address sends", async () => {
    mockEstimate(1_000);
    mocks.streamCompletion.mockRejectedValue(new Error("upstream exploded"));

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await POST(
        request({}, { "x-forwarded-for": "203.0.113.7" }),
      );
      await response.text();

      expect(response.status).toBe(200);
    }

    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("closes the stream even when finalizing throws", async () => {
    mockEstimate(1_000);
    mocks.streamCompletion.mockRejectedValue(new Error("upstream exploded"));
    mocks.finalizeStream.mockRejectedValueOnce(new Error("storage exploded"));

    // The response ends (no hang until the platform timeout).
    await (await POST(request())).text();
    await mocks.afterCallback?.();

    expect(mocks.finalizeStream).toHaveBeenCalledTimes(1);
  });

  it("admits a caller who brings their own API key without any limiter dependency", async () => {
    mockEstimate(1_000);
    mocks.resolveRequestCredentials.mockResolvedValue({ apiKey: "sk-user" });

    const response = await POST(request());
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("rejects an oversized repository before any model call", async () => {
    mockEstimate(950_000);

    const response = await POST(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-generation-session-id")).toBeTruthy();
    expect(body).toContain('"error_code":"TOKEN_LIMIT_EXCEEDED"');
    expect(mocks.streamCompletion).not.toHaveBeenCalled();
  });

  it("rejects a repository at exactly the hard token limit", async () => {
    mockEstimate(900_000);

    const response = await POST(request());
    const body = await response.text();

    expect(body).toContain('"error_code":"TOKEN_LIMIT_EXCEEDED"');
    expect(mocks.streamCompletion).not.toHaveBeenCalled();
  });

  it("allows a large repository on the server key with no daily gate", async () => {
    mockEstimate(150_000);
    // Credentials saved in the HttpOnly cookies, as the route reads them.
    mocks.resolveRequestCredentials.mockResolvedValueOnce({
      apiKey: "stored-openai-key",
      githubPat: "stored-github-pat",
    });
    const generationRequest = request();

    const response = await POST(generationRequest);
    await response.text();

    expect(mocks.resolveRequestCredentials).toHaveBeenCalledWith(
      generationRequest,
      { apiKey: undefined, githubPat: undefined },
    );
    expect(mocks.getGithubData).toHaveBeenCalledWith(
      "openai",
      "openai-node",
      "stored-github-pat",
      expect.any(AbortSignal),
    );
    expect(mocks.estimateCost).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "stored-openai-key" }),
    );
  });

  it("persists one audit and closes a failed stream without any quota accounting", async () => {
    mockEstimate(100);
    mocks.streamCompletion.mockRejectedValue(new Error("Provider unavailable"));

    const response = await POST(request());
    const body = await response.text();

    expect(mocks.persistAudit).toHaveBeenCalledTimes(1);

    const persisted = mocks.persistAudit.mock.calls[0]?.[0] as {
      audit: Record<string, unknown>;
    };

    expect(persisted.audit).not.toHaveProperty("quotaStatus");
    expect(body).toContain('"error_code":"STREAM_FAILED"');
    expect(body).not.toContain('"actualCommittedTokens"');
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  describe("upstream error text in the server log", () => {
    const callerKey = "caller-key-3f9a7c21d8e5";
    const envKey = "env-router-key-77aa88bb99cc";
    const githubToken = `ghp_${"a1B2c3D4e5".repeat(4)}`;

    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    function loggedText(): string {
      return [console.error, console.warn, console.info]
        .flatMap((spy) => vi.mocked(spy).mock.calls)
        .map((call) => call.map(String).join(" "))
        .join("\n");
    }

    it("logs none of the caller key, an env key or a GitHub token in raw_error", async () => {
      const { UpstreamProviderError } =
        await import("~/server/generate/errors");

      vi.stubEnv("OPENROUTER_API_KEY", envKey);
      mockEstimate(100);
      mocks.resolveRequestCredentials.mockResolvedValue({
        apiKey: callerKey,
        githubPat: githubToken,
      });
      mocks.streamCompletion.mockRejectedValue(
        new UpstreamProviderError(
          `Incorrect API key provided: ${callerKey}. Router said ${envKey}. ` +
            `GitHub said Bad credentials for ${githubToken}; Authorization: Bearer ${githubToken}`,
        ),
      );

      const response = await POST(request());
      await response.text();

      const logged = loggedText();

      expect(logged).toContain("generate.stream.error_redacted");
      expect(logged).toContain("Incorrect API key provided");
      expect(logged).not.toContain(callerKey);
      expect(logged).not.toContain(envKey);
      expect(logged).not.toContain(githubToken);
    });

    it("does not leak a piece of a key that the 500-character cap would cut", async () => {
      const { UpstreamProviderError } =
        await import("~/server/generate/errors");

      mockEstimate(100);
      mocks.resolveRequestCredentials.mockResolvedValue({ apiKey: callerKey });
      mocks.streamCompletion.mockRejectedValue(
        new UpstreamProviderError(`${"x".repeat(495)}${callerKey}`),
      );

      const response = await POST(request());
      await response.text();

      expect(loggedText()).toContain("generate.stream.error_redacted");
      expect(loggedText()).not.toContain(callerKey.slice(0, 5));
    });
  });

  it("aborts shared generation work when distributed cancellation is observed", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const cancelToken = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    mocks.getGithubData.mockImplementation(
      (
        _username: string,
        _repo: string,
        _githubPat: string | undefined,
        signal: AbortSignal,
      ) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          queueMicrotask(() => mocks.cancellationCallback?.());
        }),
    );

    const response = await POST(
      request({ session_id: sessionId, cancel_token: cancelToken }),
    );
    const body = await response.text();
    await mocks.afterCallback?.();

    expect(response.headers.get("x-generation-session-id")).toBe(sessionId);
    expect(mocks.registerActiveGeneration).toHaveBeenCalledWith(
      sessionId,
      cancelToken,
    );
    expect(mocks.startCancellationPolling).toHaveBeenCalledWith({
      sessionId,
      onCancelled: expect.any(Function),
    });
    expect(mocks.stopCancellationPolling).toHaveBeenCalledTimes(1);
    expect(mocks.unregisterActiveGeneration).toHaveBeenCalledWith(
      sessionId,
      cancelToken,
    );
    expect(mocks.streamCompletion).not.toHaveBeenCalled();
    expect(mocks.persistAudit).not.toHaveBeenCalled();
    expect(body).not.toContain('"status":"error"');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"outcome":"cancelled"'),
    );
  });

  it("cancels immediately when the client aborted during request admission", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const cancelToken = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const abortController = new AbortController();
    // The client disconnects while admission is still mid-Redis round trips,
    // so the request signal is already aborted before the route can attach
    // its abort listener (which would then never fire).
    mocks.resolveRequestCredentials.mockImplementation(
      async (
        _request: Request,
        explicit: { apiKey?: string; githubPat?: string },
      ) => {
        abortController.abort();
        return explicit;
      },
    );

    const response = await POST(
      new Request("https://gitdiagram.com/api/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...session.headers },
        body: JSON.stringify({
          username: "openai",
          repo: "openai-node",
          session_id: sessionId,
          cancel_token: cancelToken,
        }),
        signal: abortController.signal,
      }),
    );
    const body = await response.text();
    await mocks.afterCallback?.();

    expect(mocks.getGithubData).not.toHaveBeenCalled();
    expect(mocks.streamCompletion).not.toHaveBeenCalled();
    expect(body).not.toContain('"status":"error"');
    expect(mocks.unregisterActiveGeneration).toHaveBeenCalledWith(
      sessionId,
      cancelToken,
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"outcome":"cancelled"'),
    );
  });

  it("ends cleanly without quota accounting when cancelled mid-request", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const cancelToken = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    mockEstimate(100);
    mocks.streamCompletion.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => ({
        stream: (async function* () {
          queueMicrotask(() => mocks.cancellationCallback?.());
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          yield "";
        })(),
        usagePromise: Promise.resolve(null),
      }),
    );

    const response = await POST(
      request({ session_id: sessionId, cancel_token: cancelToken }),
    );
    await response.text();

    expect(mocks.removedDependency).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"outcome":"cancelled"'),
    );
  });

  it("fails closed when cancellation registration is unavailable", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const cancelToken = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    mocks.registerActiveGeneration.mockRejectedValueOnce(
      new Error("secret Upstash failure"),
    );

    const response = await POST(
      request({ session_id: sessionId, cancel_token: cancelToken }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "CANCELLATION_UNAVAILABLE",
    });
    expect(mocks.getGithubData).not.toHaveBeenCalled();
    expect(mocks.startCancellationPolling).not.toHaveBeenCalled();
  });

  it("sends a slim success audit without duplicating result bodies", async () => {
    mockEstimate(100);
    const usage = {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      cachedInputTokens: 40,
      reasoningTokens: 10,
    };
    mocks.streamCompletion.mockResolvedValue({
      stream: (async function* () {
        yield "<explanation>Hello-world request flow.</explanation>";
      })(),
      usagePromise: Promise.resolve(usage),
    });
    const graph = {
      groups: [],
      nodes: [
        {
          id: "entrypoint",
          label: "Entry point",
          type: "TypeScript module",
          description: null,
          groupId: null,
          path: "src/index.ts",
          shape: "box",
        },
      ],
      edges: [],
    };
    mocks.generateStructuredOutput.mockResolvedValue({
      output: graph,
      rawText: JSON.stringify(graph),
      usage,
    });

    const response = await POST(request());
    const events = readSseEvents(await response.text());
    const terminal = events.find((event) => event.status === "complete");
    const terminalAudit = terminal?.latest_session_audit as
      Record<string, unknown> | undefined;

    expect(terminal).toMatchObject({
      status: "complete",
      explanation: "Hello-world request flow.",
      graph,
    });
    expect(terminal?.diagram).toEqual(expect.stringContaining("flowchart TD"));
    expect(terminal).not.toHaveProperty("graph_attempts");
    expect(terminalAudit).toMatchObject({
      status: "succeeded",
      graph: null,
      graphAttempts: [],
      stageUsages: [],
      timeline: [],
    });
    expect(terminalAudit).not.toHaveProperty("quotaStatus");
    expect(terminalAudit).not.toHaveProperty("explanation");
    expect(terminalAudit).not.toHaveProperty("compiledDiagram");
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"cached_input_tokens":80'),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"reasoning_tokens":20'),
    );
    expect(mocks.clearFailureSummary).not.toHaveBeenCalled();
    await mocks.afterCallback?.();
    expect(mocks.clearFailureSummary).toHaveBeenCalledWith({
      username: "openai",
      repo: "openai-node",
      githubPat: undefined,
      visibility: "public",
    });
    expect(mocks.writePublicPreview).toHaveBeenCalledWith({
      username: "openai",
      repo: "openai-node",
      diagram: expect.stringContaining("flowchart TD"),
      lastSuccessfulAt: expect.any(String),
    });
  });

  it("completes a local-model stream with n/a cost in the terminal and audit", async () => {
    vi.mocked(getProvider).mockReturnValue("openai-compatible");
    mocks.getModel.mockReturnValue("local/mistral-small");
    mocks.estimateCost.mockResolvedValue({
      costSummary: {
        kind: "estimate",
        approximate: true,
        amountUsd: null,
        display: "n/a",
        pricingModel: "local/mistral-small",
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      },
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      pricingModel: "local/mistral-small",
      pricing: null,
      explanationInputTokens: 100,
      graphStaticInputTokens: 100,
      graphRepairStaticInputTokens: null,
    });
    const usage = { inputTokens: 80, outputTokens: 20, totalTokens: 100 };
    mocks.providerStreamText.mockResolvedValue({
      stream: (async function* () {
        yield "<explanation>Local repository flow.</explanation>";
      })(),
      usagePromise: Promise.resolve(usage),
    });
    const graph = {
      groups: [],
      nodes: [
        {
          id: "entrypoint",
          label: "Entry point",
          type: "TypeScript module",
          description: null,
          groupId: null,
          path: "src/index.ts",
          shape: "box",
        },
      ],
      edges: [],
    };
    mocks.providerParseStructured.mockResolvedValue({
      output: graph,
      rawText: JSON.stringify(graph),
      usage,
    });

    const response = await POST(request());
    const events = readSseEvents(await response.text());
    const terminal = events.find((event) => event.status === "complete");

    expect(terminal).toMatchObject({
      status: "complete",
      cost_summary: {
        kind: "actual",
        amountUsd: null,
        display: "n/a",
        usage: { inputTokens: 160, outputTokens: 40, totalTokens: 200 },
      },
      latest_session_audit: {
        finalCost: { amountUsd: null, display: "n/a" },
      },
    });
    expect(mocks.saveDiagram).toHaveBeenCalled();
  });

  it("streams and plans the graph through the same selected provider instance", async () => {
    mockEstimate(100);
    const usage = { inputTokens: 80, outputTokens: 20, totalTokens: 100 };
    const explanation = {
      stream: (async function* () {
        yield "<explanation>Provider interface.</explanation>";
      })(),
      usagePromise: Promise.resolve(usage),
    };
    const graph = {
      groups: [],
      nodes: [
        {
          id: "entry",
          label: "Entry",
          type: "module",
          description: null,
          groupId: null,
          path: "src/index.ts",
          shape: "box",
        },
      ],
      edges: [],
    };
    mocks.providerStreamText.mockResolvedValue(explanation);
    mocks.providerParseStructured.mockResolvedValue({
      output: graph,
      rawText: JSON.stringify(graph),
      usage,
    });
    mocks.streamCompletion.mockResolvedValue(explanation);
    mocks.generateStructuredOutput.mockResolvedValue({
      output: graph,
      rawText: JSON.stringify(graph),
      usage,
    });

    const response = await POST(request());
    const terminal = readSseEvents(await response.text()).find(
      (event) => event.status === "complete",
    );

    expect(terminal).toMatchObject({
      status: "complete",
      explanation: "Provider interface.",
      graph,
      cost_summary: { kind: "actual" },
    });
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
    expect(mocks.providerStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        signal: expect.any(AbortSignal),
        clientRequestId: expect.stringMatching(/:explanation$/),
      }),
    );
    expect(mocks.providerParseStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: "diagram_graph",
        signal: expect.any(AbortSignal),
        clientRequestId: expect.stringMatching(/:graph:1$/),
      }),
    );
    expect(mocks.streamCompletion).not.toHaveBeenCalled();
    expect(mocks.generateStructuredOutput).not.toHaveBeenCalled();
  });

  it("keeps the final cost labeled as an estimate when stage usage is missing", async () => {
    mockEstimate(100);
    mocks.streamCompletion.mockResolvedValue({
      stream: (async function* () {
        yield "<explanation>Usage-free explanation.</explanation>";
      })(),
      usagePromise: Promise.resolve(null),
    });
    const graph = {
      groups: [],
      nodes: [
        {
          id: "entrypoint",
          label: "Entry point",
          type: "TypeScript module",
          description: null,
          groupId: null,
          path: "src/index.ts",
          shape: "box",
        },
      ],
      edges: [],
    };
    mocks.generateStructuredOutput.mockResolvedValue({
      output: graph,
      rawText: JSON.stringify(graph),
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });

    const response = await POST(request());
    const terminal = readSseEvents(await response.text()).find(
      (event) => event.status === "complete",
    );

    expect(terminal?.cost_summary).toMatchObject({
      kind: "estimate",
      approximate: true,
      note: expect.stringContaining("remains an estimate"),
    });
  });

  it("streams complete output beyond estimates with no quota accounting", async () => {
    mockEstimate(100);
    const usage = {
      inputTokens: 80,
      outputTokens: 12_000,
      totalTokens: 12_080,
    };
    const sourceChunks = [
      "<explanation>",
      "Hello",
      " ",
      "streaming",
      " world.",
      "</explanation>",
    ];
    mocks.streamCompletion.mockResolvedValue({
      stream: (async function* () {
        yield* sourceChunks;
      })(),
      usagePromise: Promise.resolve(usage),
    });
    const graph = {
      groups: [],
      nodes: [
        {
          id: "entrypoint",
          label: "Entry point",
          type: "TypeScript module",
          description: null,
          groupId: null,
          path: "src/index.ts",
          shape: "box",
        },
      ],
      edges: [],
    };
    mocks.generateStructuredOutput.mockResolvedValue({
      output: graph,
      rawText: JSON.stringify(graph),
      usage,
    });

    const response = await POST(request());
    const events = readSseEvents(await response.text());
    const explanationChunks = events
      .filter((event) => event.status === "explanation_chunk")
      .map((event) => event.chunk as string);

    expect(mocks.streamCompletion.mock.calls[0]?.[0]).not.toHaveProperty(
      "maxOutputTokens",
    );
    expect(
      mocks.generateStructuredOutput.mock.calls[0]?.[0],
    ).not.toHaveProperty("maxOutputTokens");
    expect(mocks.removedDependency).not.toHaveBeenCalled();
    expect(explanationChunks.join("")).toBe(sourceChunks.join(""));
    expect(explanationChunks.length).toBeLessThan(sourceChunks.length);
    expect(events.at(-1)).toMatchObject({
      status: "complete",
      explanation: "Hello streaming world.",
    });
  });

  it("logs sanitized validation categories for successful retry sessions", async () => {
    mockEstimate(100);
    const usage = { inputTokens: 80, outputTokens: 20, totalTokens: 100 };
    mocks.streamCompletion.mockResolvedValue({
      stream: (async function* () {
        yield "<explanation>Retry diagnostics.</explanation>";
      })(),
      usagePromise: Promise.resolve(usage),
    });
    const invalidGraph = {
      groups: [],
      nodes: [
        {
          id: "entrypoint",
          label: "Entry point",
          type: "TypeScript module",
          description: null,
          groupId: null,
          path: "src/private-name.ts",
          shape: "box",
        },
      ],
      edges: [],
    };
    const validGraph = {
      ...invalidGraph,
      nodes: [{ ...invalidGraph.nodes[0], path: "src/index.ts" }],
    };
    mocks.generateStructuredOutput
      .mockResolvedValueOnce({
        output: invalidGraph,
        rawText: JSON.stringify(invalidGraph),
        usage,
      })
      .mockResolvedValueOnce({
        output: validGraph,
        rawText: JSON.stringify(validGraph),
        usage,
      });

    const response = await POST(request());
    await response.text();
    const finishLog = vi
      .mocked(console.info)
      .mock.calls.map(([value]) => String(value))
      .find((value) => value.includes('"event":"generate.stream.finished"'));
    const finishEvent = JSON.parse(finishLog ?? "{}") as Record<
      string,
      unknown
    >;

    expect(finishEvent.graph_validation_categories).toEqual({
      missing_repository_path: 1,
    });
    expect(finishLog).not.toContain("private-name");
  });
  it.each([false, true])(
    "generates architecture in one Luna request and only makes another call for a needed repair (%s)",
    async (repair) => {
      mocks.getModel.mockReturnValue("gpt-5.6-luna");
      const paths = Array.from(
        { length: 12 },
        (_, i) => `src/component${i}.ts`,
      );
      mocks.getGithubData.mockResolvedValue({
        defaultBranch: "main",
        fileTree: paths.join("\n"),
        pathTypes: new Map(paths.map((path) => [path, "blob"])),
        readme: "Application",
        isPrivate: false,
        stargazerCount: 0,
      });
      mockEstimate(1000);
      const usage = {
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        serviceTier: "priority",
      };
      const graph = {
        groups: [],
        nodes: [
          {
            id: "entry",
            label: "Entry",
            type: "module",
            description: null,
            groupId: null,
            path: paths[0],
            shape: null,
          },
        ],
        edges: [],
      };
      const explanation = 'A sourced application brief with "quoted" paths.';
      const initialGraph = repair
        ? {
            ...graph,
            edges: [
              {
                from: "missing",
                to: "entry",
                label: null,
                description: null,
                style: null,
              },
            ],
          }
        : graph;
      const output = JSON.stringify({ explanation, graph: initialGraph });
      mocks.streamCompletion.mockResolvedValue({
        stream: (async function* () {
          for (let i = 0; i < output.length; i += 17)
            yield output.slice(i, i + 17);
        })(),
        usagePromise: Promise.resolve(usage),
      });
      mocks.generateStructuredOutput.mockResolvedValue({
        output: graph,
        rawText: JSON.stringify(graph),
        usage,
      });
      const response = await POST(request());
      const events = readSseEvents(await response.text());
      const terminal = events.find((event) => event.status === "complete");
      expect(
        events
          .filter((e) => e.status === "explanation_chunk")
          .map((e) => e.chunk)
          .join(""),
      ).toBe(explanation);
      expect(mocks.streamCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.6-luna",
          userPrompt: expect.stringContaining("<source_files>"),
        }),
      );
      expect(mocks.generateStructuredOutput).toHaveBeenCalledTimes(
        repair ? 1 : 0,
      );
      if (repair)
        expect(mocks.generateStructuredOutput).toHaveBeenCalledWith(
          expect.objectContaining({
            model: "gpt-5.6-luna",
            userPrompt: expect.stringContaining("<validation_feedback>"),
          }),
        );
      expect(terminal).toMatchObject({
        cost_summary: {
          kind: "actual",
          amountUsd: repair ? 0.0056 : 0.0028,
          pricingModel: "gpt-5.6-luna",
        },
        latest_session_audit: {
          model: "gpt-5.6-luna",
          analysisModel: "gpt-5.6-luna",
        },
      });
    },
  );
  it("recovers a slow Luna stream once and resets partial text", async () => {
    vi.useFakeTimers();
    try {
      mocks.getModel.mockReturnValue("gpt-5.6-luna");
      mockEstimate(1000);
      const usage = {
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        serviceTier: "priority",
      };
      const output = JSON.stringify({
        explanation: "Fresh overview",
        graph: {
          groups: [],
          nodes: [
            {
              id: "entry",
              label: "Entry",
              groupId: null,
              path: "src/index.ts",
              shape: "box",
            },
          ],
          edges: [],
        },
      });
      let firstSignal: AbortSignal | undefined;
      mocks.streamCompletion.mockReset();
      mocks.streamCompletion
        .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
          firstSignal = signal;
          return {
            stream: (async function* () {
              yield '{"explanation":"Abandoned';
              await new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            })(),
            usagePromise: Promise.resolve(null),
          };
        })
        .mockResolvedValueOnce({
          stream: (async function* () {
            yield output;
          })(),
          usagePromise: Promise.resolve(usage),
        });
      const response = await POST(request());
      const body = response.text();
      await vi.advanceTimersByTimeAsync(18_001);
      const events = readSseEvents(await body);
      expect(firstSignal?.aborted).toBe(true);
      expect(mocks.streamCompletion).toHaveBeenCalledTimes(2);
      expect(mocks.streamCompletion.mock.calls[1]?.[0]).toMatchObject({
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          status: "explanation",
          explanation: "",
          message: "Retrying a slow model request...",
        }),
      );
      expect(events.find((event) => event.status === "complete")).toMatchObject(
        {
          explanation: "Fresh overview",
        },
      );
      expect(mocks.removedDependency).not.toHaveBeenCalled();
      expect(mocks.generateStructuredOutput).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

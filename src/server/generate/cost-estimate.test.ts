import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationProvider } from "~/server/ai/provider";
import { toTaggedMessage } from "~/server/generate/format";
import {
  SYSTEM_FIRST_PROMPT,
  SYSTEM_GRAPH_PROMPT,
} from "~/server/generate/prompts";
import { estimateTokens } from "~/server/generate/token-estimate";

const { countInputTokens } = vi.hoisted(() => ({
  countInputTokens: vi.fn(),
}));

import { estimateGenerationCost } from "~/server/generate/cost-estimate";

const countingProvider = {
  streamText: vi.fn(),
  parseStructured: vi.fn(),
  countInputTokens,
} as unknown as GenerationProvider;
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("estimateGenerationCost", () => {
  it("counts through the selected provider and preserves request cancellation metadata", async () => {
    const countProviderTokens = vi.fn(async () => 175);
    const generationProvider = {
      streamText: vi.fn(),
      parseStructured: vi.fn(),
      countInputTokens: countProviderTokens,
    } as unknown as GenerationProvider;
    const signal = new AbortController().signal;

    const result = await estimateGenerationCost({
      provider: "openai",
      generationProvider,
      model: "gpt-5.6-terra",
      fileTree: "src/index.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
      preferExactInputTokenCount: true,
      signal,
      clientRequestId: "estimate-1",
    });

    expect(countProviderTokens).toHaveBeenCalledTimes(2);
    expect(countProviderTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        signal,
        clientRequestId: "estimate-1:explanation",
      }),
    );
    expect(countProviderTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        signal,
        clientRequestId: "estimate-1:graph",
      }),
    );
    expect(countInputTokens).not.toHaveBeenCalled();
    expect(result.explanationInputTokens).toBe(175);
    expect(result.graphStaticInputTokens).toBe(175);
  });

  it("uses the local estimate when the selected provider has no token counter", async () => {
    const generationProvider = {
      streamText: vi.fn(),
      parseStructured: vi.fn(),
    } as unknown as GenerationProvider;

    const result = await estimateGenerationCost({
      provider: "openai",
      generationProvider,
      model: "gpt-5.6-terra",
      fileTree: "src/index.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
      preferExactInputTokenCount: true,
    });

    expect(countInputTokens).not.toHaveBeenCalled();
    expect(result.costSummary.note).toContain("approximated");
  });

  it("keeps a local model's estimated usage while marking its price unavailable", async () => {
    const generationProvider = {
      streamText: vi.fn(),
      parseStructured: vi.fn(),
    } as unknown as GenerationProvider;

    const result = await estimateGenerationCost({
      provider: "openai-compatible",
      generationProvider,
      model: "local/mistral-small",
      fileTree: "src/index.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
      preferExactInputTokenCount: true,
    });

    expect(result.explanationInputTokens).toBeGreaterThan(0);
    expect(result.graphStaticInputTokens).toBeGreaterThan(0);
    expect(result.explanationInputTokens).toBe(
      estimateTokens(
        `${SYSTEM_FIRST_PROMPT}\n${toTaggedMessage({
          file_tree: "src/index.ts",
          readme: "# Demo",
          source_files: "",
        })}`,
      ),
    );
    expect(result.graphStaticInputTokens).toBe(
      estimateTokens(
        `${SYSTEM_GRAPH_PROMPT}\n${toTaggedMessage({ explanation: "" })}`,
      ),
    );
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.costSummary).toMatchObject({
      amountUsd: null,
      display: "n/a",
      pricingModel: "local/mistral-small",
    });
    expect(result.pricing).toBeNull();
    expect(result.analysisPricing).toBeNull();
    expect(result.costSummary.note).toContain("approximated");
    expect(countInputTokens).not.toHaveBeenCalled();
  });

  it("does not apply OpenAI pricing to a local endpoint using an OpenAI model id", async () => {
    const generationProvider = {
      streamText: vi.fn(),
      parseStructured: vi.fn(),
    } as unknown as GenerationProvider;

    const result = await estimateGenerationCost({
      provider: "openai-compatible",
      generationProvider,
      model: "gpt-6-luna",
      fileTree: "src/index.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
      preferExactInputTokenCount: true,
    });

    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.costSummary).toMatchObject({
      amountUsd: null,
      display: "n/a",
      pricingModel: "gpt-6-luna",
    });
    expect(result.pricing).toBeNull();
    expect(countInputTokens).not.toHaveBeenCalled();
  });

  it("prices the operator key and caller key at standard stage rates", async () => {
    process.env.AI_API_KEY = "operator-owned-key";
    const params = {
      provider: "openai" as const,
      generationProvider: countingProvider,
      model: "gpt-5.6-luna",
      analysisModel: "gpt-5.6-sol",
      fileTree: "src/main.ts",
      readme: "Demo",
      username: "acme",
      repo: "demo",
    };
    const managed = await estimateGenerationCost(params);
    const ownKey = await estimateGenerationCost({
      ...params,
      apiKey: "user-key",
    });
    expect(managed.costSummary.amountUsd).toBeCloseTo(0.166175);
    expect(managed.estimatedOutputTokens).toBe(14000);
    expect(ownKey.estimatedOutputTokens).toBe(14000);
    expect(managed.analysisPricing).toEqual({
      inputPerMillionUsd: 4,
      outputPerMillionUsd: 20,
    });
    expect(managed.pricing).toEqual({
      inputPerMillionUsd: 0.2,
      outputPerMillionUsd: 1.2,
    });
    expect(managed.graphServiceTier).toBe("default");
    expect(ownKey.graphServiceTier).toBe("default");
  });
  beforeEach(() => {
    countInputTokens.mockReset();
    countInputTokens.mockImplementation(
      async ({ userPrompt }: { userPrompt: string }) => {
        if (userPrompt.includes("<readme>")) return 100;
        if (userPrompt.includes("<file_tree>")) return 300;
        return 200;
      },
    );
  });

  it("uses the stage policy and counts only the first-pass graph input", async () => {
    const result = await estimateGenerationCost({
      provider: "openai",
      generationProvider: countingProvider,
      model: "gpt-5.6-terra",
      fileTree: "src/main.ts\nsrc/worker.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
      apiKey: "sk-user",
    });

    expect(result.explanationInputTokens).toBe(100);
    expect(result.graphStaticInputTokens).toBe(200);
    expect(result.graphRepairStaticInputTokens).toBeNull();
    expect(result.estimatedInputTokens).toBe(8_300);
    expect(result.estimatedOutputTokens).toBe(14_000);

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    const calls = countInputTokens.mock.calls.map(([call]) => call);
    const explanationCall = calls.find(({ userPrompt }) =>
      userPrompt.includes("<readme>"),
    );
    const firstGraphCall = calls.find(
      ({ userPrompt }) =>
        userPrompt.includes("<explanation>") &&
        !userPrompt.includes("<file_tree>"),
    );

    expect(explanationCall?.reasoningEffort).toBe("low");
    expect(firstGraphCall?.reasoningEffort).toBe("medium");
    expect(firstGraphCall?.userPrompt).not.toContain("<repo_owner>");
    expect(firstGraphCall?.userPrompt).not.toContain("<repo_name>");
    expect(firstGraphCall?.userPrompt).not.toContain("<previous_graph>");
    expect(firstGraphCall?.userPrompt).not.toContain("<validation_feedback>");
    expect(
      calls.some(
        ({ userPrompt }) =>
          userPrompt.includes("<file_tree>") &&
          userPrompt.includes("<explanation>"),
      ),
    ).toBe(false);
  });

  it("no longer offers the includeGraphRepairInputTokens option", async () => {
    const source = await readFile(
      join(process.cwd(), "src/server/generate/cost-estimate.ts"),
      "utf8",
    );

    expect(source).not.toContain("includeGraphRepairInputTokens");
  });

  it("never counts a repair prompt", async () => {
    const result = await estimateGenerationCost({
      provider: "openai",
      generationProvider: countingProvider,
      model: "gpt-5.6-terra",
      fileTree: "src/main.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
      apiKey: "sk-user",
    });

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(result.graphRepairStaticInputTokens).toBeNull();
  });

  it("falls back to a local estimate for a provider counting failure", async () => {
    countInputTokens.mockRejectedValue(new Error("Provider unavailable"));

    const result = await estimateGenerationCost({
      provider: "openai",
      generationProvider: countingProvider,
      model: "gpt-5.6-terra",
      fileTree: "src/main.ts",
      readme: "# Demo",
      username: "acme",
      repo: "demo",
    });

    expect(result.costSummary.note).toContain(
      "Some input tokens were approximated",
    );
    expect(result.explanationInputTokens).toBeGreaterThan(0);
    expect(result.graphStaticInputTokens).toBeGreaterThan(0);
    expect(result.pricing).toEqual({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 12,
    });
  });

  it("propagates an AbortSignal instead of converting it to a local estimate", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException(
      "Cost deadline exceeded",
      "TimeoutError",
    );
    countInputTokens.mockImplementation(async () => {
      controller.abort(abortReason);
      throw new Error("Provider request aborted");
    });

    await expect(
      estimateGenerationCost({
        provider: "openai",
        generationProvider: countingProvider,
        model: "gpt-5.6-terra",
        fileTree: "src/main.ts",
        readme: "# Demo",
        username: "acme",
        repo: "demo",
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
  });
});

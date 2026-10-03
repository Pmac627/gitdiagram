import { describe, expect, it, vi } from "vitest";

import type { GenerationProvider } from "~/server/ai/provider";
import { generateValidatedGraph } from "~/server/generate/graph-planner";
import { createGenerationSessionAudit } from "~/server/generate/session-audit";

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
      shape: "box" as const,
    },
  ],
  edges: [],
};

function graphParams(
  generationProvider: GenerationProvider,
  signal: AbortSignal,
) {
  return {
    provider: "openai" as const,
    generationProvider,
    model: "gpt-5.6-terra",
    sessionId: "session-1",
    explanation: "The entry module starts the application.",
    fileTree: "src/index.ts",
    fileTreeLookup: new Set(["src/index.ts"]),
    signal,
    audit: createGenerationSessionAudit({
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5.6-terra",
    }),
    accounting: {
      actualUsages: [],
      hasCompleteMeasuredUsage: true,
    },
    validationCategoryCounts: {},
    recordTiming: vi.fn(),
    send: vi.fn(async () => true),
  };
}

describe("generateValidatedGraph provider interface", () => {
  it("uses parseStructured and preserves the signal, request id, and measured usage", async () => {
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
    const parseStructured = vi.fn(async () => ({
      output: graph,
      rawText: JSON.stringify(graph),
      usage,
    }));
    const provider = {
      streamText: vi.fn(),
      parseStructured,
    } as unknown as GenerationProvider;
    const controller = new AbortController();
    const params = graphParams(provider, controller.signal);

    const result = await generateValidatedGraph(params);

    expect(result.ok).toBe(true);
    expect(parseStructured).toHaveBeenCalledOnce();
    expect(parseStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        schemaName: "diagram_graph",
        signal: controller.signal,
        clientRequestId: "session-1:graph:1",
      }),
    );
    expect(params.accounting.actualUsages).toEqual([usage]);
    expect(result.audit.stageUsages).toEqual([
      expect.objectContaining({ stage: "graph_attempt", attempt: 1 }),
    ]);
  });

  it("does not call the provider after cancellation", async () => {
    const parseStructured = vi.fn();
    const provider = {
      streamText: vi.fn(),
      parseStructured,
    } as unknown as GenerationProvider;
    const controller = new AbortController();
    const abortReason = new DOMException("Cancelled", "AbortError");
    controller.abort(abortReason);

    await expect(
      generateValidatedGraph(graphParams(provider, controller.signal)),
    ).rejects.toBe(abortReason);
    expect(parseStructured).not.toHaveBeenCalled();
  });
});

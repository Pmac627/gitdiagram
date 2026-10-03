import { describe, expect, it } from "vitest";

import type { GenerationCostSummary } from "~/features/diagram/cost";
import type {
  DiagramGraph,
  GenerationSessionAudit,
  GraphAttemptAudit,
} from "~/features/diagram/graph";
import {
  createGenerationSessionAudit,
  toTerminalSessionAudit,
  withEstimatedCost,
  withFinalCost,
  withRedactedSecrets,
} from "~/server/generate/session-audit";
import { createCostSummary } from "~/server/generate/pricing";

// Fields an earlier release wrote and this one no longer knows.
const LEGACY_QUOTA_FIELDS = {
  quotaStatus: "finalized",
  quotaBucket: "daily",
  quotaDateUtc: "2026-07-13",
  actualCommittedTokens: 2_920,
  quotaResetAt: "2026-07-14T00:00:00.000Z",
} as const;

const createdAt = "2026-07-13T17:00:00.000Z";
const updatedAt = "2026-07-13T17:00:12.000Z";

const graph: DiagramGraph = {
  groups: [
    {
      id: "application",
      label: "Application",
      description: "Core application components",
    },
  ],
  nodes: [
    {
      id: "entrypoint",
      label: "Entry point",
      type: "TypeScript module",
      description: "Starts the application",
      groupId: "application",
      path: "src/index.ts",
      shape: "box",
    },
    {
      id: "service",
      label: "Service",
      type: "TypeScript module",
      description: "Handles application work",
      groupId: "application",
      path: "src/service.ts",
      shape: "box",
    },
  ],
  edges: [
    {
      from: "entrypoint",
      to: "service",
      label: "calls",
      description: "Delegates application work",
      style: "solid",
    },
  ],
};

const actualCost: GenerationCostSummary = {
  kind: "actual",
  approximate: false,
  amountUsd: 0.0142,
  display: "$0.0142 USD",
  pricingModel: "gpt-5.6-terra",
  usage: {
    inputTokens: 2_400,
    outputTokens: 520,
    totalTokens: 2_920,
  },
};

function graphAttempt(
  attempt: number,
  status: GraphAttemptAudit["status"],
): GraphAttemptAudit {
  return {
    attempt,
    rawOutput: JSON.stringify(graph),
    graph,
    validationFeedback:
      status === "failed" ? "Node path does not exist in the tree." : undefined,
    status,
    createdAt,
  };
}

function sessionAudit(
  status: GenerationSessionAudit["status"],
): GenerationSessionAudit {
  return {
    sessionId: "session-123",
    status,
    stage: status === "succeeded" ? "complete" : "graph_validating",
    provider: "openai",
    model: "gpt-5.6-terra",
    estimatedCost: { ...actualCost, kind: "estimate", approximate: true },
    finalCost: actualCost,
    explanation: "This repository has a compact request flow. ".repeat(35),
    graph,
    graphAttempts: [graphAttempt(1, "failed"), graphAttempt(2, "succeeded")],
    stageUsages: [
      {
        stage: "explanation",
        model: "gpt-5.6-terra",
        costSummary: actualCost,
        createdAt,
      },
      {
        stage: "graph_attempt",
        attempt: 2,
        model: "gpt-5.6-terra",
        costSummary: actualCost,
        createdAt,
      },
    ],
    compiledDiagram:
      "flowchart TD\n  entrypoint[Entry point] --> service[Service]\n".repeat(
        12,
      ),
    validationError:
      status === "failed" ? "Graph validation did not converge." : undefined,
    failureStage: status === "failed" ? "graph_validating" : undefined,
    timeline: Array.from({ length: 8 }, (_, index) => ({
      stage: `stage_${index}`,
      message: `Generation stage ${index}`,
      createdAt,
    })),
    createdAt,
    updatedAt,
  };
}

describe("legacy quota fields", () => {
  it("are never on a freshly created audit", () => {
    const audit = createGenerationSessionAudit({
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5.6-terra",
    });

    for (const field of Object.keys(LEGACY_QUOTA_FIELDS)) {
      expect(audit, field).not.toHaveProperty(field);
      expect(JSON.stringify(audit)).not.toContain(field);
    }
  });

  it("are dropped when an old audit that still has them is summarized", () => {
    const old = {
      ...sessionAudit("succeeded"),
      ...LEGACY_QUOTA_FIELDS,
    } as GenerationSessionAudit;
    const summary = toTerminalSessionAudit(old);

    for (const field of Object.keys(LEGACY_QUOTA_FIELDS)) {
      expect(summary, field).not.toHaveProperty(field);
    }
    expect(summary.finalCost).toEqual(actualCost);
  });
});

describe("toTerminalSessionAudit", () => {
  it("retains unavailable local-model costs and measured usage in the saved audit", () => {
    const usage = { inputTokens: 90, outputTokens: 10, totalTokens: 100 };
    const estimate = createCostSummary({
      kind: "estimate",
      model: "local/mistral-small",
      usage,
      approximate: true,
    });
    const actual = createCostSummary({
      kind: "actual",
      model: "local/mistral-small",
      usage,
      approximate: false,
    });
    const audit = withFinalCost(
      withEstimatedCost(sessionAudit("succeeded"), estimate),
      actual,
    );

    expect(toTerminalSessionAudit(audit)).toMatchObject({
      estimatedCost: { amountUsd: null, display: "n/a", usage },
      finalCost: { amountUsd: null, display: "n/a", usage },
    });
  });

  it("keeps success cost metadata without repeating result bodies", () => {
    const audit = sessionAudit("succeeded");
    const summary = toTerminalSessionAudit(audit);

    expect(summary).toMatchObject({
      sessionId: audit.sessionId,
      status: "succeeded",
      stage: "complete",
      provider: "openai",
      model: "gpt-5.6-terra",
      finalCost: actualCost,
      graph: null,
      graphAttempts: [],
      stageUsages: [],
      timeline: [],
    });
    expect(summary).not.toHaveProperty("explanation");
    expect(summary).not.toHaveProperty("compiledDiagram");
  });

  it("preserves failed-attempt diagnostics without duplicating parsed graphs", () => {
    const summary = toTerminalSessionAudit(sessionAudit("failed"));

    expect(summary.graphAttempts).toHaveLength(1);
    expect(summary.graphAttempts[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      rawOutput: JSON.stringify(graph),
      graph: null,
      validationFeedback: "Node path does not exist in the tree.",
    });
    expect(summary.graph).toEqual(graph);
    expect(summary.validationError).toBe("Graph validation did not converge.");
    expect(summary.failureStage).toBe("graph_validating");
  });

  it("cuts a representative success terminal payload by more than half", () => {
    const audit = sessionAudit("succeeded");
    const result = {
      status: "complete",
      session_id: audit.sessionId,
      cost_summary: audit.finalCost,
      explanation: audit.explanation,
      diagram: audit.compiledDiagram,
      graph: audit.graph,
      generated_at: audit.updatedAt,
    };
    const legacyTerminal = {
      ...result,
      graph_attempts: audit.graphAttempts,
      latest_session_audit: audit,
    };
    const slimTerminal = {
      ...result,
      latest_session_audit: toTerminalSessionAudit(audit),
    };
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacyTerminal));
    const slimBytes = Buffer.byteLength(JSON.stringify(slimTerminal));

    expect(legacyBytes).toBeGreaterThan(10_000);
    expect(slimBytes).toBeLessThan(legacyBytes * 0.5);
  });
});

describe("secret redaction count in the session audit", () => {
  const base = () =>
    createGenerationSessionAudit({
      sessionId: "s1",
      provider: "openai",
      model: "m",
    });

  it("records only a count, never values, and survives the terminal projection", () => {
    const audit = withRedactedSecrets(base(), 3);

    expect(audit.redactedSecretCount).toBe(3);
    expect(toTerminalSessionAudit(audit).redactedSecretCount).toBe(3);
  });

  it("rejects a negative or non-integer count", () => {
    expect(() => withRedactedSecrets(base(), -1)).toThrow();
    expect(() => withRedactedSecrets(base(), 1.5)).toThrow();
  });

  it("leaves the count unset on a fresh audit", () => {
    expect(base().redactedSecretCount).toBeUndefined();
  });
});

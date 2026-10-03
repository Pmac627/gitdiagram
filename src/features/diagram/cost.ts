export interface GenerationTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  serviceTier?: string;
}

/** Report token usage and a price when the model has a known rate. @see docs/flows/diagram-generation.md */
export interface GenerationCostSummary {
  kind: "estimate" | "actual";
  approximate: boolean;
  amountUsd: number | null;
  display: string;
  pricingModel: string;
  usage: GenerationTokenUsage;
  note?: string;
}

export interface GenerationStageUsage {
  stage: "estimate" | "explanation" | "graph_attempt";
  attempt?: number;
  model: string;
  costSummary: GenerationCostSummary;
  createdAt: string;
}

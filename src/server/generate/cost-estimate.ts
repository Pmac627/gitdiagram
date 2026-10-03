import { toTaggedMessage } from "~/server/generate/format";
import type { GenerationProvider, ReasoningEffort } from "~/server/ai/provider";
import { estimateTokens } from "~/server/generate/token-estimate";
import {
  EXPLANATION_REASONING_EFFORT,
  getArchitectureReasoningEffort,
  GRAPH_REASONING_EFFORT,
} from "~/server/generate/generation-policy";
import {
  createEstimateCostSummary,
  estimateTextTokenCostUsd,
} from "~/server/generate/pricing";
import {
  SYSTEM_FIRST_PROMPT,
  SYSTEM_GRAPH_PROMPT,
  SYSTEM_ARCHITECTURE_PROMPT,
} from "~/server/generate/prompts";
import {
  type AIProvider,
  supportsExactInputTokenCount,
  getGenerationServiceTier,
  usesSinglePassArchitecture,
  type GenerationServiceTier,
} from "~/server/generate/model-config";

interface CountPromptInputTokensParams {
  provider: AIProvider;
  generationProvider?: GenerationProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  reasoningEffort?: ReasoningEffort;
  preferExactInputTokenCount?: boolean;
  signal?: AbortSignal;
  clientRequestId?: string;
}

interface CountPromptInputTokensResult {
  inputTokens: number;
  usedFallback: boolean;
}

/**
 * Report the estimated usage and prices for a diagram run.
 * @see docs/flows/diagram-generation.md
 */
export interface GenerationEstimateResult {
  costSummary: ReturnType<typeof createEstimateCostSummary>;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  pricingModel: string;
  pricing: ReturnType<typeof estimateTextTokenCostUsd>["pricing"];
  analysisPricing?: ReturnType<typeof estimateTextTokenCostUsd>["pricing"];
  explanationInputTokens: number;
  graphStaticInputTokens: number;
  graphRepairStaticInputTokens: number | null;
  graphServiceTier?: GenerationServiceTier;
}

async function countPromptInputTokens({
  provider,
  generationProvider,
  model,
  systemPrompt,
  userPrompt,
  reasoningEffort,
  preferExactInputTokenCount = true,
  signal,
  clientRequestId,
}: CountPromptInputTokensParams): Promise<CountPromptInputTokensResult> {
  signal?.throwIfAborted();

  if (
    !preferExactInputTokenCount ||
    !generationProvider?.countInputTokens ||
    !supportsExactInputTokenCount(provider)
  ) {
    return {
      inputTokens: estimateTokens(`${systemPrompt}\n${userPrompt}`),
      usedFallback: true,
    };
  }

  try {
    const inputTokens = await generationProvider.countInputTokens({
      model,
      systemPrompt,
      userPrompt,
      reasoningEffort,
      signal,
      clientRequestId,
    });

    return {
      inputTokens,
      usedFallback: false,
    };
  } catch {
    // Provider failures can safely fall back to the local estimate, but an
    // aborted request must stop all parallel token-count calls immediately.
    // Swallowing the abort here would let the cost route overrun its deadline.
    signal?.throwIfAborted();

    return {
      inputTokens: estimateTokens(`${systemPrompt}\n${userPrompt}`),
      usedFallback: true,
    };
  }
}

/**
 * Estimate generation usage with the selected provider's token counter.
 * @see docs/flows/diagram-generation.md
 */
export async function estimateGenerationCost(params: {
  provider: AIProvider;
  generationProvider?: GenerationProvider;
  model: string;
  analysisModel?: string;
  sourceFiles?: string;
  sourceTokenReserve?: number;
  fileTree: string;
  readme: string;
  username: string;
  repo: string;
  apiKey?: string;
  preferExactInputTokenCount?: boolean;
  signal?: AbortSignal;
  clientRequestId?: string;
}): Promise<GenerationEstimateResult> {
  const singlePass = usesSinglePassArchitecture(params);
  const analysisServiceTier = getGenerationServiceTier({
    ...params,
    model: params.analysisModel ?? params.model,
  });
  const graphServiceTier = getGenerationServiceTier(params);
  const explanationPrompt = toTaggedMessage({
    file_tree: params.fileTree,
    readme: params.readme,
    source_files: params.sourceFiles ?? "",
  });
  const graphPromptWithoutExplanation = toTaggedMessage({
    explanation: "",
  });

  const [explanationCount, graphStaticCount] = await Promise.all([
    countPromptInputTokens({
      provider: params.provider,
      generationProvider: params.generationProvider,
      model: params.analysisModel ?? params.model,
      systemPrompt: singlePass
        ? SYSTEM_ARCHITECTURE_PROMPT
        : SYSTEM_FIRST_PROMPT,
      userPrompt: explanationPrompt,
      reasoningEffort: singlePass
        ? getArchitectureReasoningEffort(params.analysisModel ?? params.model)
        : EXPLANATION_REASONING_EFFORT,
      preferExactInputTokenCount: params.preferExactInputTokenCount,
      signal: params.signal,
      clientRequestId: params.clientRequestId
        ? `${params.clientRequestId}:explanation`
        : undefined,
    }),
    countPromptInputTokens({
      provider: params.provider,
      generationProvider: params.generationProvider,
      model: params.model,
      systemPrompt: SYSTEM_GRAPH_PROMPT,
      userPrompt: graphPromptWithoutExplanation,
      reasoningEffort: GRAPH_REASONING_EFFORT,
      preferExactInputTokenCount: params.preferExactInputTokenCount,
      signal: params.signal,
      clientRequestId: params.clientRequestId
        ? `${params.clientRequestId}:graph`
        : undefined,
    }),
  ]);

  const noteParts = [
    singlePass
      ? "Estimate assumes one architecture request and the estimated output usage; repairs and actual usage may cost more."
      : "Estimate assumes one graph-planning attempt and the estimated output usage; actual usage may be higher.",
  ];
  if (explanationCount.usedFallback || graphStaticCount.usedFallback) {
    noteParts.push(
      "Some input tokens were approximated with a conservative local fallback.",
    );
  }

  const costSummary = createEstimateCostSummary({
    model: params.model,
    provider: params.provider,
    analysisModel: params.analysisModel,
    analysisServiceTier,
    graphServiceTier,
    singlePass,
    explanationInputTokens:
      explanationCount.inputTokens + (params.sourceTokenReserve ?? 0),
    graphStaticInputTokens: graphStaticCount.inputTokens,
    approximate: true,
    note: noteParts.join(" "),
  });

  const { pricing } = estimateTextTokenCostUsd(
    params.model,
    costSummary.usage.inputTokens,
    costSummary.usage.outputTokens,
    graphServiceTier,
    params.provider,
  );

  return {
    costSummary,
    graphServiceTier,
    estimatedInputTokens: costSummary.usage.inputTokens,
    estimatedOutputTokens: costSummary.usage.outputTokens,
    pricingModel: costSummary.pricingModel,
    pricing,
    analysisPricing: estimateTextTokenCostUsd(
      params.analysisModel ?? params.model,
      0,
      0,
      analysisServiceTier,
      params.provider,
    ).pricing,
    explanationInputTokens:
      explanationCount.inputTokens + (params.sourceTokenReserve ?? 0),
    graphStaticInputTokens: graphStaticCount.inputTokens,
    // Repairs are not counted up front, so there is no static repair estimate.
    graphRepairStaticInputTokens: null,
  };
}

import type { GenerationSessionAudit } from "~/features/diagram/graph";
import type { GenerationUsageAccounting } from "~/server/generate/graph-planner";
import type { GraphValidationCategory } from "~/server/generate/graph";
import { sumGenerationUsage } from "~/server/generate/pricing";
import type { GenerationStreamState } from "~/server/generate/sse-writer";
import {
  persistGenerationResult,
  type SuccessfulDiagramState,
} from "~/server/storage/generation-persistence";
import type { ArtifactVisibility } from "~/server/storage/types";

type PostResponseTask = () => Promise<void>;

export interface FinalizeGenerationStreamParams {
  abortCause: "client" | "deadline" | null;
  apiKey?: string;
  audit: GenerationSessionAudit;
  githubPat?: string;
  postResponseTasks: PostResponseTask[];
  recordTiming: (stage: string, startedAt: number) => void;
  repo: string;
  repositoryVerified: boolean;
  sendTerminal: (
    audit: GenerationSessionAudit,
    persistenceWarning?: string,
  ) => Promise<boolean>;
  storageVisibility: ArtifactVisibility;
  successfulDiagramState: SuccessfulDiagramState | null;
  username: string;
}

export async function finalizeGenerationStream(
  params: FinalizeGenerationStreamParams,
): Promise<GenerationSessionAudit> {
  const audit = params.audit;
  let terminalSent = false;
  let persistenceWarning: string | undefined;

  if (params.abortCause === "deadline") {
    terminalSent = await params.sendTerminal(audit);
  }

  if (params.repositoryVerified) {
    persistenceWarning = await persistGenerationResult({
      username: params.username,
      repo: params.repo,
      githubPat: params.githubPat,
      visibility: params.storageVisibility,
      audit,
      successfulDiagramState: params.successfulDiagramState,
      usedOwnKey: Boolean(params.apiKey),
      postResponseTasks: params.postResponseTasks,
      recordTiming: params.recordTiming,
    });
  }

  if (!terminalSent) {
    await params.sendTerminal(audit, persistenceWarning);
  }

  return audit;
}

export function logGenerationFinished(params: {
  accounting: GenerationUsageAccounting;
  audit: GenerationSessionAudit;
  graphValidationCategoryCounts: Partial<
    Record<GraphValidationCategory, number>
  >;
  invocationStartedAt: number;
  stageTimingsMs: Record<string, number>;
  storageVisibility: ArtifactVisibility;
  streamState: GenerationStreamState;
  terminalErrorCode: string | null;
}) {
  const totalUsage = sumGenerationUsage(...params.accounting.actualUsages);
  console.info(
    JSON.stringify({
      event: "generate.stream.finished",
      session_id: params.audit.sessionId,
      outcome: params.streamState.wasCancelled
        ? "cancelled"
        : params.audit.status === "succeeded"
          ? "succeeded"
          : "failed",
      error_code: params.terminalErrorCode,
      stage: params.audit.failureStage ?? params.audit.stage,
      elapsed_ms: Math.round(performance.now() - params.invocationStartedAt),
      stage_timings_ms: params.stageTimingsMs,
      provider: params.audit.provider,
      model: params.audit.model,
      analysis_model: params.audit.analysisModel ?? params.audit.model,
      source_file_count: params.audit.sourcePaths?.length ?? 0,
      unavailable_source_count: params.audit.unavailableSourceCount ?? 0,
      redacted_secret_count: params.audit.redactedSecretCount ?? 0,
      cost_usd: params.audit.finalCost?.amountUsd,
      cost_is_estimate: params.audit.finalCost?.kind === "estimate",
      slow_request_retries: params.audit.stageUsages.filter(
        (stage) =>
          stage.stage === "explanation" &&
          stage.costSummary.kind === "estimate",
      ).length,
      visibility: params.storageVisibility,
      input_tokens: totalUsage.inputTokens,
      output_tokens: totalUsage.outputTokens,
      total_tokens: totalUsage.totalTokens,
      cache_write_tokens: totalUsage.cacheWriteTokens ?? 0,
      cached_input_tokens: totalUsage.cachedInputTokens ?? 0,
      reasoning_tokens: totalUsage.reasoningTokens ?? 0,
      graph_validation_categories: params.graphValidationCategoryCounts,
    }),
  );
}

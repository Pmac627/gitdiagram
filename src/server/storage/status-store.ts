import type { DiagramStateResponse } from "~/features/diagram/types";
import type { GenerationSessionAudit } from "~/features/diagram/graph";
import {
  getReadLocations,
  getWriteLocation,
  type StorageLocation,
} from "~/server/storage/cache-key";
import { getDb, withImmediateTransaction } from "~/server/storage/db";
import { kvRead, kvRemove, kvWrite } from "~/server/storage/kv";
import type {
  ArtifactVisibility,
  StoredFailureSummary,
} from "~/server/storage/types";

const STATUS_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function toDiagramStateResponse(
  summary: StoredFailureSummary,
): DiagramStateResponse {
  return {
    diagram: null,
    explanation: null,
    graph: null,
    latestSessionAudit: summary.latestSessionSummary,
    lastSuccessfulAt: null,
  };
}

async function getSummaryForLocation(
  location: StorageLocation,
): Promise<StoredFailureSummary | null> {
  const result = kvRead(getDb(), location.statusKey, Date.now());
  if (!result) {
    return null;
  }

  return JSON.parse(result) as StoredFailureSummary;
}

export async function getStoredFailureState(params: {
  username: string;
  repo: string;
  githubPat?: string;
}): Promise<DiagramStateResponse | null> {
  for (const location of getReadLocations(params)) {
    const summary = await getSummaryForLocation(location);
    if (summary) {
      return toDiagramStateResponse(summary);
    }
  }

  return null;
}

export async function writeFailureSummary(params: {
  username: string;
  repo: string;
  githubPat?: string;
  visibility: ArtifactVisibility;
  latestSessionSummary: GenerationSessionAudit;
}): Promise<void> {
  const location = getWriteLocation(params);

  const summary: StoredFailureSummary = {
    version: 1,
    visibility: params.visibility,
    username: params.username,
    repo: params.repo,
    latestSessionSummary: params.latestSessionSummary,
  };

  withImmediateTransaction((db) => {
    const now = Date.now();

    // Expired summaries read as absent; drop them so the table stays small.
    db.prepare("DELETE FROM kv WHERE expires_at <= ?").run(now);
    kvWrite(
      db,
      location.statusKey,
      JSON.stringify(summary),
      STATUS_TTL_MS,
      now,
    );
  });
}

export async function clearFailureSummary(params: {
  username: string;
  repo: string;
  githubPat?: string;
  visibility: ArtifactVisibility;
}): Promise<void> {
  const location = getWriteLocation(params);

  withImmediateTransaction((db) => {
    kvRemove(db, location.statusKey);
  });
}

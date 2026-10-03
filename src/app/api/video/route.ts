import { z } from "zod";
import { requireOperator } from "~/server/auth/require-operator";

import {
  githubRepoSchema,
  githubUsernameSchema,
} from "~/server/generate/types";
import {
  jsonErrorResponse,
  NO_STORE_RESPONSE_HEADERS,
} from "~/server/http/same-origin-json";
import {
  canGenerateVideos,
  isVideoExplainerEnabled,
  isVideoRenderEnabled,
} from "~/server/explainer/config";
import { generationLockName, isVideoLockHeld } from "~/server/explainer/limits";
import { isNarrationAvailable } from "~/server/explainer/narration";
import { readVideoArtifact } from "~/server/explainer/store";
import type { VideoPausedReason } from "~/features/explainer/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const querySchema = z.object({
  username: githubUsernameSchema,
  repo: githubRepoSchema,
});

/**
 * Whether a new video could start right now, and if not, why: "limit" (the
 * narrator is out of credit, so a paid script could not be voiced).
 */
async function videoAvailability(): Promise<{
  canGenerate: boolean;
  paused: VideoPausedReason | null;
}> {
  if (!canGenerateVideos()) return { canGenerate: false, paused: "limit" };
  if (process.env.NODE_ENV !== "production") {
    // Local preview of the paused state: VIDEO_PREVIEW_PAUSED=limit.
    return process.env.VIDEO_PREVIEW_PAUSED === "limit"
      ? { canGenerate: false, paused: "limit" }
      : { canGenerate: true, paused: null };
  }
  // The voice-credit check applies to the operator too, as in the generate route.
  try {
    if (!(await isNarrationAvailable())) {
      return { canGenerate: false, paused: "limit" };
    }
    return { canGenerate: true, paused: null };
  } catch {
    // When the narrator cannot be checked, nothing new starts (see the generate route).
    return { canGenerate: false, paused: "limit" };
  }
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireOperator(request);
  if (denied) return denied;

  if (!isVideoExplainerEnabled())
    return jsonErrorResponse("Explainer videos are not enabled.", 404);
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    username: url.searchParams.get("username"),
    repo: url.searchParams.get("repo"),
  });
  if (!parsed.success) return jsonErrorResponse("Invalid repository.", 400);
  const { username, repo } = parsed.data;
  const video = await readVideoArtifact(username, repo);
  if (video)
    return Response.json(
      {
        ok: true,
        video,
        canGenerate: false,
        paused: null,
        renderEnabled: isVideoRenderEnabled(),
      },
      {
        headers: {
          // A stored video changes only when the operator regenerates it,
          // which a copy up to a minute old can outlive.
          "Cache-Control": "private, max-age=60",
        },
      },
    );
  const [availability, generating] = await Promise.all([
    videoAvailability(),
    // A run in progress, which the page can wait for instead of offering a
    // new one. Only production takes the lock.
    process.env.NODE_ENV === "production"
      ? isVideoLockHeld(generationLockName(username, repo))
      : false,
  ]);
  // Never cached, so a waiting page sees the video once it lands.
  return Response.json(
    {
      ok: true,
      video: null,
      generating,
      renderEnabled: isVideoRenderEnabled(),
      ...availability,
    },
    { headers: NO_STORE_RESPONSE_HEADERS },
  );
}

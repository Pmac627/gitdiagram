import { after } from "next/server";
import { z } from "zod";
import { requireOperator } from "~/server/auth/require-operator";

import {
  githubRepoSchema,
  githubUsernameSchema,
} from "~/server/generate/types";
import {
  jsonErrorResponse,
  NO_STORE_RESPONSE_HEADERS,
  parseSameOriginJsonRequest,
} from "~/server/http/same-origin-json";
import { refreshVideoPages } from "~/server/explainer/cache";
import {
  canGenerateVideos,
  isVideoExplainerEnabled,
  isVideoRenderEnabled,
} from "~/server/explainer/config";
import { VideoRefusalError } from "~/server/explainer/director";
import { generateExplainerVideo } from "~/server/explainer/generate";
import {
  generationLockName,
  pausedMessage,
  tryPaidVideoRun,
  tryVideoLock,
} from "~/server/explainer/limits";
import { isNarrationAvailable } from "~/server/explainer/narration";
import { choosePlanner } from "~/server/explainer/planner";
import { VideoInputError } from "~/server/explainer/repository";
import { remakePosterRemotely } from "~/server/explainer/segments";
import { readVideoArtifact } from "~/server/explainer/store";
import { VoiceUnavailableError } from "~/server/explainer/voice";
import { errorText, logEvent } from "~/server/log";
import {
  isWindowsDeviceName,
  toStorageSegment,
} from "~/server/storage/fs-safety";
import type {
  VideoArtifact,
  VideoGenerationEvent,
} from "~/features/explainer/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// A run gives up here, leaving the rest of maxDuration to report the failure,
// release its lock, and store the poster of a run that made it.
const VIDEO_DEADLINE_MS = 240_000;
// The lock and the paid-run place outlive the function if it dies.
const RUN_TTL_MS = 6 * 60_000;
// Everything, the poster included, is done by here: short of maxDuration, so
// the function always ends on its own rather than being stopped.
const FUNCTION_BUDGET_MS = 285_000;
// With less time than this left, the poster is not attempted (a poster can
// be remade later from the player).
const MIN_POSTER_MS = 20_000;

const requestSchema = z.strictObject({
  username: githubUsernameSchema,
  repo: githubRepoSchema,
  // Replacing a stored video is explicit. Without this flag an existing video
  // answers 409 "exists".
  regenerate: z.boolean().optional(),
});

const UNAVAILABLE_MESSAGE =
  "Video generation is unavailable right now. Try again soon.";
const BUSY_MESSAGE =
  "Lots of videos are being made right now. Try again in a few minutes.";
const NARRATOR_MESSAGE =
  "The narrator is unavailable right now. Try again in a few minutes.";

/** The cap on paid runs at once was reached just before the first model call. */
class PaidRunsBusyError extends Error {}

/** What the viewer is told when a run fails. Only a refusal or bad input is final. */
function failureEvent(
  error: unknown,
  { timedOut }: { timedOut: boolean },
): Extract<VideoGenerationEvent, { status: "error" }> {
  if (error instanceof VideoInputError)
    return { status: "error", error: error.message, retryable: false };
  if (error instanceof VideoRefusalError)
    return {
      status: "error",
      error: "An explainer video can't be made for this repository.",
      retryable: false,
    };
  if (error instanceof VoiceUnavailableError)
    return { status: "error", error: NARRATOR_MESSAGE, retryable: true };
  if (error instanceof PaidRunsBusyError)
    return { status: "error", error: BUSY_MESSAGE, retryable: true };
  const failed = timedOut
    ? "The explainer video took too long to make."
    : "The explainer video could not be generated.";
  return { status: "error", error: `${failed} Try again.`, retryable: true };
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOperator(request);
  if (denied) return denied;

  const requestStartedAt = Date.now();
  if (!isVideoExplainerEnabled())
    return jsonErrorResponse("Explainer videos are not enabled.", 404);
  const parsed = await parseSameOriginJsonRequest(request, {
    schema: requestSchema,
    maxBytes: 1024,
    crossOriginError: "Video generation must come from GitDiagram.",
  });
  if (!parsed.success) return parsed.response;
  if (!canGenerateVideos())
    return jsonErrorResponse("Explainer videos are not available.", 503);
  const { username, repo, regenerate = false } = parsed.data;
  const repository = `${username}/${repo}`;
  // Fail fast: a name the video store cannot keep as a folder (a Windows
  // device name such as "con" or "aux.js", say) would only fail after the
  // paid model and voice work.
  if (isWindowsDeviceName(username) || isWindowsDeviceName(repo)) {
    return jsonErrorResponse(
      "This repository name is reserved on Windows, so its video cannot be stored on this server.",
      400,
    );
  }
  if (!toStorageSegment(username) || !toStorageSegment(repo)) {
    return jsonErrorResponse(
      "This repository name cannot be stored on this server.",
      400,
    );
  }
  const production = process.env.NODE_ENV === "production";

  // `reason` lets the panel show the video (or wait for it) instead of an error.
  const alreadyMade = () =>
    Response.json(
      {
        ok: false,
        error: "This repository already has a video.",
        reason: "exists",
      },
      { status: 409, headers: NO_STORE_RESPONSE_HEADERS },
    );
  let releaseLock: (() => Promise<void>) | null = null;
  let releaseRun: (() => Promise<void>) | null = null;
  const release = async () => {
    await releaseRun?.();
    await releaseLock?.();
  };
  // Lets go of what admission took when no run starts after all.
  const turnAway = async (response: Response) => {
    await release();
    return response;
  };
  try {
    // Every caller here is the operator, so the checks that protect paid work
    // apply to all of them: an existing video is replaced only on request, and
    // nothing starts while the narrator cannot be paid for.
    if (!regenerate && (await readVideoArtifact(username, repo))) {
      return alreadyMade();
    }

    if (!(await isNarrationAvailable())) {
      return jsonErrorResponse(pausedMessage("voice"), 503);
    }
    if (production) {
      releaseLock = await tryVideoLock(
        generationLockName(username, repo),
        RUN_TTL_MS,
      );
      if (!releaseLock)
        return await turnAway(
          Response.json(
            {
              ok: false,
              error:
                "This video is being made right now. It will be here in about a minute.",
              reason: "generating",
            },
            { status: 409, headers: NO_STORE_RESPONSE_HEADERS },
          ),
        );
      // Checked again under the lock: a run that finished between the first
      // check and taking the lock has stored its video by now.
      if (!regenerate && (await readVideoArtifact(username, repo))) {
        return await turnAway(alreadyMade());
      }
    }
  } catch (error) {
    // SQLite and the disk hold the locks and the videos, so without them
    // nothing new is started.
    logEvent("error", "video.admission_failed", { error: errorText(error) });
    return turnAway(jsonErrorResponse(UNAVAILABLE_MESSAGE, 503));
  }

  const siteOrigin = new URL(request.url).origin;
  const encoder = new TextEncoder();
  const deadline = AbortSignal.timeout(VIDEO_DEADLINE_MS);
  let stored: VideoArtifact | null = null;
  // A model has been called: from here on the run costs real money.
  let paid = false;
  let closed = false;
  let job: Promise<void> = Promise.resolve();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: VideoGenerationEvent) =>
        write(`data: ${JSON.stringify(event)}\n\n`);
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const onEvent = (event: VideoGenerationEvent) => {
        send(event);
      };
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);
      // Generation is not tied to this connection: a finished video is stored,
      // so a viewer who leaves early still gets it on their next visit.
      job = generateExplainerVideo({
        username,
        repo,
        onEvent,
        // Paid runs at once are capped, and a run only takes its place here,
        // once it has read the repository, so runs that fail before any
        // model call never crowd out ones that are being paid for.
        onPaidWork: async () => {
          if (production) {
            releaseRun = await tryPaidVideoRun({
              operator: true,
              ttlMs: RUN_TTL_MS,
            });
            if (!releaseRun) {
              throw new PaidRunsBusyError("Too many paid runs at once.");
            }
          }
          paid = true;
        },
        choosePlanner: async ({ stars }) =>
          (await choosePlanner({ operator: true, stars })).planner,
        signal: deadline,
      })
        .then(
          (artifact) => {
            stored = artifact;
            send({ status: "complete", artifact });
            clearInterval(heartbeat);
            close();
          },
          async (error: unknown) => {
            logEvent("error", "video.generation_failed", {
              repository,
              paid,
              timedOut: deadline.aborted,
              error: errorText(error, 300),
            });
            send(failureEvent(error, { timedOut: deadline.aborted }));
          },
        )
        .catch((error: unknown) => {
          logEvent("error", "video.generation_cleanup_failed", {
            error: errorText(error),
          });
        })
        .finally(async () => {
          clearInterval(heartbeat);
          close();
          // Every part of the run has settled by now, so the next run of this
          // repository cannot overlap its paid work.
          await release();
        });
    },
    cancel() {
      closed = true;
    },
  });
  // Once the run has settled (and released its lock), point the pages that
  // name the video at the new one, then make its link-preview poster on a
  // render instance, within what is left of this function's time.
  after(async () => {
    await job;
    const artifact = stored;
    if (!artifact) return;
    refreshVideoPages(username, repo);
    const left = FUNCTION_BUDGET_MS - (Date.now() - requestStartedAt);
    if (!isVideoRenderEnabled()) {
      logEvent("info", "video.poster.render_disabled", { repository });
      return;
    }
    if (left < MIN_POSTER_MS) {
      logEvent("warn", "video.poster.skipped", { repository, leftMs: left });
      return;
    }
    if (await remakePosterRemotely(artifact, siteOrigin, { timeoutMs: left }))
      refreshVideoPages(username, repo);
    else logEvent("error", "video.poster.remote_failed", { repository });
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

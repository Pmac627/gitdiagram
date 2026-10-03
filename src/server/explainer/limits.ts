import "server-only";

import { randomUUID } from "node:crypto";
import { readIntEnv } from "~/server/env";
import { verifyAdminRequest } from "~/server/auth/operator";
import { errorText, logEvent } from "~/server/log";
import { tryDistributedLock } from "~/server/storage/distributed-lock";
import { getDb, withImmediateTransaction } from "~/server/storage/db";

// Every new video spends real money (Claude or GPT, plus the voice). This
// tool is private, so there are no per-person or per-day budgets. What stays
// is a cap on paid runs at once across every instance, a lock per repository,
// and the automatic voice-credit pause (see voice.ts).

/**
 * The operator may regenerate: only a signed-in session cookie counts. An
 * Authorization header is never read.
 * @see docs/flows/explainer-video.md
 */
export function isVideoAdmin(request: Request): Promise<boolean> {
  return verifyAdminRequest(request);
}

/** A trusted video caller has the operator session cookie. */
export async function isTrustedVideoCaller(request: Request): Promise<boolean> {
  return isVideoAdmin(request);
}

// Paid runs at once (VIDEO_MAX_PAID_RUNS, default 10). Each run makes one
// short voice call (voice.ts), which OpenRouter does not rate-limit, so the
// voice does not cap this.
const maxPaidRuns = () => readIntEnv("VIDEO_MAX_PAID_RUNS", 10);

/**
 * A place among the videos being paid for right now, or null when the cap is
 * reached. Taken just before a run's first model call, so runs still reading
 * the repository (or failing to) hold none. The operator's runs count toward
 * it but are never refused. A run that dies without releasing its place
 * loses it after ttlMs.
 */
export async function tryPaidVideoRun(params: {
  operator: boolean;
  ttlMs: number;
}): Promise<(() => Promise<void>) | null> {
  if (!Number.isFinite(params.ttlMs) || params.ttlMs <= 0) {
    throw new Error(
      "A paid run lease must be a positive number of milliseconds.",
    );
  }

  const token = randomUUID();
  const now = Date.now();
  const cap = maxPaidRuns();

  // Count, check and insert share one write transaction, so two processes
  // never both take the last place.
  const admitted = withImmediateTransaction((db) => {
    db.prepare("DELETE FROM paid_runs WHERE expires_at <= ?").run(now);

    const row = db
      .prepare("SELECT COUNT(*) AS running FROM paid_runs")
      .get() as {
      running: number;
    };

    if (!params.operator && Number(row.running) >= cap) {
      return false;
    }

    db.prepare("INSERT INTO paid_runs (token, expires_at) VALUES (?, ?)").run(
      token,
      now + params.ttlMs,
    );

    return true;
  });

  if (!admitted) {
    return null;
  }

  return async () => {
    try {
      getDb().prepare("DELETE FROM paid_runs WHERE token = ?").run(token);
    } catch (error) {
      logEvent("error", "video.paid_run.release_failed", {
        error: errorText(error),
      });
    }
  };
}

/**
 * One holder at a time across every server instance, or null if someone else
 * holds it. The lock expires on its own if the holder dies.
 */
export function tryVideoLock(
  name: string,
  ttlMs: number,
): Promise<(() => Promise<void>) | null> {
  return tryDistributedLock({
    key: `video:v1:lock:${name}`,
    ttlMs,
    releaseFailureEvent: "video.lock.release_failed",
  });
}

/** The lock a repository's video generation holds while it runs. */
export const generationLockName = (username: string, repo: string) =>
  `generate:${username}/${repo}`.toLowerCase();

/** Whether someone holds the lock right now. False when the database cannot say. */
export async function isVideoLockHeld(name: string): Promise<boolean> {
  try {
    const row = getDb()
      .prepare("SELECT 1 AS held FROM locks WHERE key = ? AND expires_at > ?")
      .get(`video:v1:lock:${name}`, Date.now());

    return row !== undefined;
  } catch {
    return false;
  }
}

const STILL_FREE =
  "Every video that's already been made is still free to watch.";

/**
 * Why new videos are paused: the narrator's balance ran out ("voice"), which
 * lifts on its own within minutes.
 * @see docs/flows/explainer-video.md
 */
export function pausedMessage(_reason: "voice"): string {
  return `New videos are paused for a few minutes. Try again soon. ${STILL_FREE}`;
}

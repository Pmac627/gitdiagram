import "server-only";

import type { AdminState } from "~/features/admin/types";
import * as voice from "~/server/explainer/voice";

// The dashboard polls this every 5 s. The voice balance comes from an outside
// service (OpenRouter) that can be slow, so it gets a short deadline of its
// own and shows as unreadable past it, rather than holding up the dashboard. A late answer is not wasted: it is cached, so the next poll gets it.

const BALANCE_DEADLINE_MS = 3_000;
// OpenRouter's balance moves only as videos are voiced.
const VOICE_CACHE_MS = 30_000;

async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** Rejects once `ms` pass; the work itself carries on. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Too slow.")), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

let voiceCache: { at: number; usd: Promise<number | null> } | null = null;

/** The voice balance, read from OpenRouter at most every half minute. */
function cachedVoiceCredit(now = Date.now()): Promise<number | null> {
  if (!voiceCache || now - voiceCache.at > VOICE_CACHE_MS)
    voiceCache = { at: now, usd: voice.voiceCreditUsd().catch(() => null) };
  return voiceCache.usd;
}

/** Everything the dashboard polls: the voice balance and its pause. */
export async function readAdminState(): Promise<AdminState> {
  const [voicePausedUntil, voiceCreditUsd] = await Promise.all([
    orNull(voice.voicePausedUntil()),
    orNull(within(cachedVoiceCredit(), BALANCE_DEADLINE_MS)),
  ]);
  return {
    now: Date.now(),
    voicePausedUntil,
    voiceCreditUsd,
  };
}

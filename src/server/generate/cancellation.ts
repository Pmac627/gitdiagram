import { getDb, withImmediateTransaction } from "~/server/storage/db";
import {
  kvRead,
  kvRemove,
  kvWrite,
  kvWriteIfAbsent,
} from "~/server/storage/kv";

export const GENERATION_CANCELLATION_TTL_SECONDS = 10 * 60;
export const GENERATION_ACTIVE_TTL_SECONDS = 6 * 60;
/**
 * A cancel request can race ahead of the generation route: the client's
 * keepalive cancel POST may land while request admission is still busy
 * and has not registered its active session yet. Such an early cancel is
 * recorded as a token-bound pending marker with a short TTL; registration
 * atomically promotes a matching marker into a real cancellation flag so the
 * generation observes it on its first poll instead of running to the deadline.
 */
export const GENERATION_PENDING_CANCELLATION_TTL_SECONDS = 60;
/**
 * Cancellation is user-initiated and rare, so a flat one-second poll spends
 * hundreds of database reads per generation to detect an event that
 * usually never happens. Stay responsive while the user is most likely to hit
 * cancel, then back off for the long tail of a slow generation.
 */
const GENERATION_CANCELLATION_POLL_SCHEDULE = [
  { throughElapsedMs: 15_000, intervalMs: 1_000 },
  { throughElapsedMs: 60_000, intervalMs: 3_000 },
] as const;
const GENERATION_CANCELLATION_MAX_POLL_INTERVAL_MS = 5_000;

function pollIntervalForElapsed(elapsedMs: number): number {
  for (const step of GENERATION_CANCELLATION_POLL_SCHEDULE) {
    if (elapsedMs < step.throughElapsedMs) {
      return step.intervalMs;
    }
  }
  return GENERATION_CANCELLATION_MAX_POLL_INTERVAL_MS;
}

function getActiveGenerationKey(sessionId: string): string {
  return `generation:active:${sessionId}`;
}

function getCancellationKey(sessionId: string): string {
  return `generation:cancel:${sessionId}`;
}

const seconds = (value: number) => value * 1_000;

/**
 * Registers the active session once (never replacing a collision). A pending
 * cancel with the same token becomes a real flag; one with another token is a
 * stale marker from an earlier session with this id and is cleared.
 */
export async function registerActiveGeneration(
  sessionId: string,
  cancelToken: string,
): Promise<boolean> {
  const now = Date.now();

  return withImmediateTransaction((db) => {
    // Keeps the table small: expired rows read as absent anyway.
    db.prepare("DELETE FROM kv WHERE expires_at <= ?").run(now);

    if (
      !kvWriteIfAbsent(
        db,
        getActiveGenerationKey(sessionId),
        cancelToken,
        seconds(GENERATION_ACTIVE_TTL_SECONDS),
        now,
      )
    ) {
      return false;
    }

    const cancelKey = getCancellationKey(sessionId);
    const pending = kvRead(db, cancelKey, now);

    if (pending === cancelToken) {
      kvWrite(
        db,
        cancelKey,
        "1",
        seconds(GENERATION_CANCELLATION_TTL_SECONDS),
        now,
      );
    } else if (pending !== null) {
      kvRemove(db, cancelKey);
    }

    return true;
  });
}

/**
 * Cancels an active session when the token matches (true). With another
 * token nothing changes (false). With no active session the cancel is stored
 * as the raw token (never "1", so polling ignores it) for registration to
 * promote, and the result is false.
 */
export async function markGenerationCancelled(
  sessionId: string,
  cancelToken: string,
): Promise<boolean> {
  const now = Date.now();

  return withImmediateTransaction((db) => {
    const active = kvRead(db, getActiveGenerationKey(sessionId), now);
    const cancelKey = getCancellationKey(sessionId);

    if (active === cancelToken) {
      kvWrite(
        db,
        cancelKey,
        "1",
        seconds(GENERATION_CANCELLATION_TTL_SECONDS),
        now,
      );

      return true;
    }

    if (active === null) {
      kvWrite(
        db,
        cancelKey,
        cancelToken,
        seconds(GENERATION_PENDING_CANCELLATION_TTL_SECONDS),
        now,
      );
    }

    return false;
  });
}

export async function unregisterActiveGeneration(
  sessionId: string,
  cancelToken: string,
): Promise<void> {
  const now = Date.now();

  withImmediateTransaction((db) => {
    if (kvRead(db, getActiveGenerationKey(sessionId), now) !== cancelToken) {
      return;
    }

    kvRemove(db, getActiveGenerationKey(sessionId));
    kvRemove(db, getCancellationKey(sessionId));
  });
}

export async function isGenerationCancelled(
  sessionId: string,
): Promise<boolean> {
  return kvRead(getDb(), getCancellationKey(sessionId), Date.now()) === "1";
}

export function startGenerationCancellationPolling(params: {
  sessionId: string;
  onCancelled: () => void;
}): () => void {
  let stopped = false;
  let pollFailureLogged = false;
  let elapsedMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Each poll schedules the next one only after it settles, so a slow database
  // round trip can never stack overlapping requests.
  const scheduleNextPoll = () => {
    if (stopped) {
      return;
    }

    const intervalMs = pollIntervalForElapsed(elapsedMs);
    timer = setTimeout(() => {
      elapsedMs += intervalMs;
      void poll();
    }, intervalMs);
  };

  const poll = async () => {
    if (stopped) {
      return;
    }

    try {
      const cancelled = await isGenerationCancelled(params.sessionId);
      if (stopped) {
        return;
      }

      pollFailureLogged = false;
      if (cancelled) {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
        params.onCancelled();
        return;
      }
    } catch {
      if (!stopped && !pollFailureLogged) {
        pollFailureLogged = true;
        console.warn(
          JSON.stringify({
            event: "generate.cancellation.poll_failed",
            session_id: params.sessionId,
            error: "Cancellation status is temporarily unavailable.",
          }),
        );
      }
    }

    scheduleNextPoll();
  };

  void poll();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

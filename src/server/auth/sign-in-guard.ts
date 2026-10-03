import "server-only";

import { logEvent } from "~/server/log";
import { withImmediateTransaction } from "~/server/storage/db";
import { kvRead, kvWrite, kvWriteIfAbsent } from "~/server/storage/kv";

const FAILURES_KEY = "operator:v1:sign-in-failures";
const BLOCK_LOGGED_KEY = "operator:v1:sign-in-block-logged";
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** Outcome of a global operator token attempt. @see docs/flows/operator-live-ops.md */
export interface SignInCheck {
  blocked: boolean;
  retryAfterSeconds: number;
}

/** Count wrong tokens in SQLite without trusting caller supplied IP headers. @see docs/flows/operator-live-ops.md */
export async function checkSignIn(
  _request: Request,
  correct: boolean,
): Promise<SignInCheck> {
  try {
    let announce = 0;

    const check = withImmediateTransaction((db) => {
      const now = Date.now();
      const raw = kvRead(db, FAILURES_KEY, now);
      const parsed = raw
        ? (JSON.parse(raw) as { count: number; until: number })
        : null;

      if (
        parsed &&
        (!Number.isSafeInteger(parsed.count) ||
          parsed.count < 0 ||
          !Number.isSafeInteger(parsed.until))
      ) {
        throw new Error("Invalid operator sign-in counter.");
      }

      const active = parsed && parsed.until > now ? parsed : null;
      const count = (active?.count ?? 0) + (correct ? 0 : 1);
      const until = active?.until ?? now + WINDOW_MS;

      if (!correct && count <= MAX_FAILURES) {
        kvWrite(
          db,
          FAILURES_KEY,
          JSON.stringify({ count, until }),
          until - now,
          now,
        );
      }

      const blocked = correct ? count >= MAX_FAILURES : count > MAX_FAILURES;

      const retryAfterSeconds = blocked
        ? Math.max(1, Math.ceil((until - now) / 1000))
        : 0;

      // One log line per block window, kept in SQLite with the window so it
      // survives restarts and is shared by every process.
      if (
        blocked &&
        kvWriteIfAbsent(db, BLOCK_LOGGED_KEY, "1", until - now, now)
      ) {
        announce = retryAfterSeconds;
      }

      return { blocked, retryAfterSeconds };
    });

    if (announce > 0) {
      logEvent("warn", "auth.sign_in.blocked", {
        retryAfterSeconds: announce,
      });
    }

    return check;
  } catch {
    return { blocked: true, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) };
  }
}

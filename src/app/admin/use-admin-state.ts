"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AdminState } from "~/features/admin/types";

// The dashboard's polled state (the voice balance). Reads can overlap: the 5 s
// poll and one when the tab shows again. Only the newest read may land, and
// the poll skips a beat while a read is under way.

const POLL_MS = 5_000;
// A read that hangs would otherwise hold up every poll after it.
const READ_TIMEOUT_MS = 10_000;

/** Signed out (or signed out everywhere): back to the sign-in form. */
const backToSignIn = () => window.location.reload();

export function useAdminState() {
  const [state, setState] = useState<AdminState | null>(null);
  const issued = useRef(0);
  const reading = useRef(0);
  const refresh = useCallback(async ({ poll = false } = {}) => {
    if (poll && reading.current > 0) {
      return;
    }
    const id = ++issued.current;
    reading.current += 1;
    // Covers reading the body too, so it is cleared only once that is done.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), READ_TIMEOUT_MS);
    try {
      const response = await fetch("/api/admin/state", {
        cache: "no-store",
        signal: timeout.signal,
      }).catch(() => null);
      if (id !== issued.current) return;
      if (response?.status === 401) {
        backToSignIn();
        return;
      }
      if (!response?.ok) return;
      const next = (await response
        .json()
        .catch(() => null)) as AdminState | null;
      if (next && id === issued.current) setState(next);
    } finally {
      clearTimeout(timer);
      reading.current -= 1;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ poll: true });
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { state, refresh };
}

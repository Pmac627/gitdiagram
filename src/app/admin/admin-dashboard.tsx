"use client";

import { useState } from "react";

import { setAdminTools } from "~/features/admin/tools";
import { BudgetTiles } from "./budget-tiles";
import { ControlsPanel } from "./controls-panel";
import { TOUCH } from "./ui";
import { useAdminState } from "./use-admin-state";

// The voice balance is polled (use-admin-state.ts).

export function AdminDashboard() {
  const { state } = useAdminState();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<{
    message: string;
    everywhere: boolean;
  } | null>(null);

  /**
   * Signs out, then shows the sign-in form. If the server did not sign out
   * (SQLite unavailable for "everywhere", or no connection), this stays signed in
   * and says so, with a way to try again.
   */
  async function signOut(everywhere: boolean) {
    setSigningOut(true);
    setSignOutError(null);
    const response = await fetch(
      `/api/auth/session${everywhere ? "?everywhere=1" : ""}`,
      { method: "DELETE" },
    ).catch(() => null);
    // 401: this session had already ended, so it is signed out anyway.
    if (response?.ok || response?.status === 401) {
      setAdminTools(false);
      window.location.reload();
      return;
    }
    const body = (await response?.json().catch(() => null)) as {
      error?: string;
    } | null;
    setSignOutError({
      message:
        body?.error ??
        (response
          ? "Could not sign out. Try again."
          : "Could not reach GitDiagram to sign out. Check the connection and try again."),
      everywhere,
    });
    setSigningOut(false);
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">Live</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[hsl(var(--neo-soft-text))]">
          <button
            type="button"
            disabled={signingOut}
            onClick={() => void signOut(true)}
            title="Signs out every browser signed in to this dashboard"
            className={`neo-button-muted h-9 rounded-md px-3 text-sm font-semibold ${TOUCH}`}
          >
            Sign out everywhere
          </button>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => void signOut(false)}
            className={`neo-button-muted h-9 rounded-md px-3 text-sm font-semibold ${TOUCH}`}
          >
            Sign out
          </button>
        </div>
      </header>

      {signOutError ? (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border-2 border-black bg-red-100 p-3 text-sm text-black"
        >
          {signOutError.message}
          <button
            type="button"
            disabled={signingOut}
            onClick={() => void signOut(signOutError.everywhere)}
            className={`neo-button-muted h-8 rounded-md px-3 text-xs font-semibold ${TOUCH}`}
          >
            Try again
          </button>
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <ControlsPanel />
        <BudgetTiles state={state} />
      </div>
    </main>
  );
}

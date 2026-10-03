"use client";

import { useState, type FormEvent } from "react";

import { safeNextPath } from "~/lib/safe-next-path";

/** Submit the operator token and reload the chosen page with the new cookie. */
export function SignInForm({ next }: { next?: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!token || busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (response.ok) {
        window.location.assign(safeNextPath(next));

        return;
      }

      const body = (await response.json()) as { error?: unknown };

      setError(
        typeof body.error === "string"
          ? body.error
          : "Could not sign in. Try again.",
      );
    } catch {
      setError("Could not sign in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
    >
      <label className="flex flex-col gap-2 font-semibold">
        Operator token
        <input
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="rounded-md border-2 border-black bg-white p-3 text-black"
        />
      </label>
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!token || busy}
        className="neo-button-muted rounded-md p-3 font-semibold"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

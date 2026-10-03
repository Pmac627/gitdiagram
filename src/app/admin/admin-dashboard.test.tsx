import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminState } from "~/features/admin/types";
import { AdminDashboard } from "./admin-dashboard";

const adminState = (overrides: Partial<AdminState> = {}): AdminState => ({
  now: 0,
  voicePausedUntil: null,
  voiceCreditUsd: null,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

let signOut: () => Promise<Response>;
let reload: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  reload = vi.fn<() => void>();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    reload,
  });
  signOut = async () => json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return signOut();
      return json(adminState());
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderDashboard() {
  await act(async () => void render(<AdminDashboard />));
}

const signOutEverywhere = () =>
  act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    ),
  );

describe("signing out everywhere", () => {
  it("stays signed in and offers a retry when the server could not do it", async () => {
    signOut = async () =>
      json({ error: "Could not sign out everywhere. Try again." }, 503);
    await renderDashboard();
    await signOutEverywhere();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not sign out everywhere. Try again.",
    );

    signOut = async () => json({ ok: true });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Try again" })),
    );
    expect(reload).toHaveBeenCalledTimes(1);
    const deletes = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes.map(([path]) => path)).toEqual([
      "/api/auth/session?everywhere=1",
      "/api/auth/session?everywhere=1",
    ]);
  });

  it("says so when the connection failed", async () => {
    signOut = () => Promise.reject(new TypeError("Failed to fetch"));
    await renderDashboard();
    await signOutEverywhere();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Could not reach GitDiagram/,
    );
  });

  it("goes back to sign-in once it worked", async () => {
    await renderDashboard();
    await signOutEverywhere();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("what the dashboard no longer shows", () => {
  it("has no audience, place, limited-country or per-day limit controls", async () => {
    await renderDashboard();
    for (const name of [
      "Who can make new videos",
      "Limited countries",
      "Priority places",
    ]) {
      expect(screen.queryByRole("radiogroup", { name })).toBeNull();
    }
    for (const name of [
      "New videos per day",
      "Per person per day",
      "Per priority person per day",
      "Per connection per day (backstop)",
      "Share let in each day (%)",
    ]) {
      expect(screen.queryByRole("textbox", { name })).toBeNull();
    }
  });

  it("has no budget, MP4, reset or complimentary token tiles", async () => {
    await renderDashboard();
    expect(screen.queryByText(/Videos today/)).toBeNull();
    expect(screen.queryByText(/MP4s today/)).toBeNull();
    expect(screen.queryByText(/Free diagram tokens today/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset today's/ })).toBeNull();
  });

  // Phase 4 decision (1): the pause switch is gone. The voice balance stays,
  // and so does the browser-only "admin controls on video pages" toggle.
  it("has no pause switch, and keeps the voice balance and the admin-tools toggle", async () => {
    await renderDashboard();
    expect(
      screen.queryByRole("switch", { name: "Pause all new videos" }),
    ).toBeNull();
    expect(screen.queryByText(/Pause all new videos/)).toBeNull();
    expect(screen.getByText(/Voice balance/)).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: "Show admin controls on video pages",
      }),
    ).toBeInTheDocument();
  });

  it("never posts to the removed controls route", async () => {
    await renderDashboard();
    const paths = vi.mocked(fetch).mock.calls.map(([path]) => String(path));

    expect(paths.some((path) => path.includes("/api/admin/controls"))).toBe(
      false,
    );
  });

  it("has no warning about unreadable switches", async () => {
    await renderDashboard();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/live switches/i)).toBeNull();
  });
});

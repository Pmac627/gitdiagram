// @vitest-environment node
//
// status-store.ts on SQLite (Phase 5, step 18a). Same exports and signatures.
// Failure summaries are keyed by the storage location's statusKey (public, or
// private and namespaced by HMAC of the caller's token) and expire three days
// after they were written (Date.now(), so fake timers are used).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationSessionAudit } from "~/features/diagram/graph";
import { closeDb } from "~/server/storage/db";
import {
  clearFailureSummary,
  getStoredFailureState,
  writeFailureSummary,
} from "~/server/storage/status-store";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const originalEnv = { ...process.env };

let dataDir: TempDataDir;

function audit(sessionId: string): GenerationSessionAudit {
  return {
    sessionId,
    status: "failed",
    stage: "graph",
    provider: "openai",
    model: "gpt-5.6-terra",
    graph: null,
    graphAttempts: [],
    stageUsages: [],
    timeline: [],
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:05:00.000Z",
  } as unknown as GenerationSessionAudit;
}

beforeEach(async () => {
  vi.useFakeTimers();
  dataDir = await createTempDataDir();
  process.env.CACHE_KEY_SECRET = "test-cache-secret";
});

afterEach(async () => {
  vi.useRealTimers();
  await dataDir.dispose();
  for (const name of ["CACHE_KEY_SECRET"]) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
});

describe("failure summaries", () => {
  it("returns null when nothing was stored", async () => {
    await expect(
      getStoredFailureState({ username: "acme", repo: "demo" }),
    ).resolves.toBeNull();
  });

  it("stores a public summary and reads it back as a failed diagram state", async () => {
    await writeFailureSummary({
      username: "acme",
      repo: "demo",
      visibility: "public",
      latestSessionSummary: audit("s1"),
    });

    await expect(
      getStoredFailureState({ username: "acme", repo: "demo" }),
    ).resolves.toEqual({
      diagram: null,
      explanation: null,
      graph: null,
      latestSessionAudit: audit("s1"),
      lastSuccessfulAt: null,
    });
  });

  it("treats owner and repo names case-insensitively, like the storage keys", async () => {
    await writeFailureSummary({
      username: "Acme",
      repo: "Demo",
      visibility: "public",
      latestSessionSummary: audit("s1"),
    });

    const state = await getStoredFailureState({
      username: "acme",
      repo: "DEMO",
    });

    expect(state?.latestSessionAudit?.sessionId).toBe("s1");
  });

  it("replaces the earlier summary for the same repository", async () => {
    for (const id of ["s1", "s2"]) {
      await writeFailureSummary({
        username: "acme",
        repo: "demo",
        visibility: "public",
        latestSessionSummary: audit(id),
      });
    }

    const state = await getStoredFailureState({
      username: "acme",
      repo: "demo",
    });

    expect(state?.latestSessionAudit?.sessionId).toBe("s2");
  });

  it("keeps repositories independent", async () => {
    await writeFailureSummary({
      username: "acme",
      repo: "demo",
      visibility: "public",
      latestSessionSummary: audit("s1"),
    });

    await expect(
      getStoredFailureState({ username: "acme", repo: "other" }),
    ).resolves.toBeNull();
  });

  it("keeps a private summary out of public reads and other tokens", async () => {
    await writeFailureSummary({
      username: "acme",
      repo: "demo",
      githubPat: "ghp_owner",
      visibility: "private",
      latestSessionSummary: audit("private-1"),
    });

    await expect(
      getStoredFailureState({ username: "acme", repo: "demo" }),
    ).resolves.toBeNull();
    await expect(
      getStoredFailureState({
        username: "acme",
        repo: "demo",
        githubPat: "ghp_someone_else",
      }),
    ).resolves.toBeNull();
    const own = await getStoredFailureState({
      username: "acme",
      repo: "demo",
      githubPat: "ghp_owner",
    });
    expect(own?.latestSessionAudit?.sessionId).toBe("private-1");
  });

  it("prefers the caller's private summary, then falls back to the public one", async () => {
    await writeFailureSummary({
      username: "acme",
      repo: "demo",
      visibility: "public",
      latestSessionSummary: audit("public-1"),
    });
    const withToken = {
      username: "acme",
      repo: "demo",
      githubPat: "ghp_owner",
    };

    expect(
      (await getStoredFailureState(withToken))?.latestSessionAudit?.sessionId,
    ).toBe("public-1");

    await writeFailureSummary({
      ...withToken,
      visibility: "private",
      latestSessionSummary: audit("private-1"),
    });

    expect(
      (await getStoredFailureState(withToken))?.latestSessionAudit?.sessionId,
    ).toBe("private-1");
  });

  it("refuses to write a private summary without a token", async () => {
    await expect(
      writeFailureSummary({
        username: "acme",
        repo: "demo",
        visibility: "private",
        latestSessionSummary: audit("s1"),
      }),
    ).rejects.toThrow(/token/i);
  });

  it("expires three days after the write, and a rewrite restarts the clock", async () => {
    const params = {
      username: "acme",
      repo: "demo",
      visibility: "public" as const,
    };
    await writeFailureSummary({ ...params, latestSessionSummary: audit("s1") });

    vi.advanceTimersByTime(THREE_DAYS_MS - 1_000);
    await writeFailureSummary({ ...params, latestSessionSummary: audit("s2") });
    vi.advanceTimersByTime(THREE_DAYS_MS - 1_000);

    expect(
      (await getStoredFailureState({ username: "acme", repo: "demo" }))
        ?.latestSessionAudit?.sessionId,
    ).toBe("s2");

    vi.advanceTimersByTime(2_000);

    await expect(
      getStoredFailureState({ username: "acme", repo: "demo" }),
    ).resolves.toBeNull();
  });

  it("clears a summary, and clearing is idempotent", async () => {
    const params = {
      username: "acme",
      repo: "demo",
      visibility: "public" as const,
    };
    await writeFailureSummary({ ...params, latestSessionSummary: audit("s1") });

    await clearFailureSummary(params);
    await clearFailureSummary(params);

    await expect(
      getStoredFailureState({ username: "acme", repo: "demo" }),
    ).resolves.toBeNull();
  });

  it("survives a reopen of the database", async () => {
    await writeFailureSummary({
      username: "acme",
      repo: "demo",
      visibility: "public",
      latestSessionSummary: audit("s1"),
    });

    closeDb();

    await expect(
      getStoredFailureState({ username: "acme", repo: "demo" }),
    ).resolves.not.toBeNull();
  });
});

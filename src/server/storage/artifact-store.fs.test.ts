// @vitest-environment node
//
// artifact-store.ts against the real object store and SQLite locks (Phase 5,
// step 19), with no mocks: the unit tests in artifact-store.test.ts still
// pin the logic against a mocked store, this file pins that the pieces work
// together on a real DATA_DIR.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GenerationSessionAudit } from "~/features/diagram/graph";
import {
  getPublicDiagramPreview,
  getStoredDiagramState,
  updateArtifactLatestSessionSummary,
  writeDiagramArtifact,
  writePublicDiagramPreview,
} from "~/server/storage/artifact-store";
import { listObjects } from "~/server/storage/object-store";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

const graph = { groups: [], nodes: [], edges: [] };
const names = ["CACHE_KEY_SECRET"];
const originalEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));

let dataDir: TempDataDir;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  process.env.CACHE_KEY_SECRET = "test-cache-secret";
});

afterEach(async () => {
  for (const name of names) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
  await dataDir.dispose();
});

function audit(
  sessionId: string,
  createdAt: string,
  updatedAt: string,
): GenerationSessionAudit {
  return {
    sessionId,
    status: "succeeded",
    stage: "complete",
    provider: "openai",
    model: "gpt-5.6-terra",
    graph,
    graphAttempts: [],
    stageUsages: [],
    timeline: [],
    createdAt,
    updatedAt,
  } as unknown as GenerationSessionAudit;
}

function write(params: {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  diagram: string;
  visibility?: "public" | "private";
  githubPat?: string;
  repo?: string;
}) {
  return writeDiagramArtifact({
    username: "Acme",
    repo: params.repo ?? "Demo",
    githubPat: params.githubPat,
    visibility: params.visibility ?? "public",
    stargazerCount: 1,
    diagram: params.diagram,
    explanation: `${params.diagram} explanation`,
    graph: graph as never,
    generatedAt: params.updatedAt,
    usedOwnKey: false,
    latestSessionSummary: audit(
      params.sessionId,
      params.createdAt,
      params.updatedAt,
    ),
    lastSuccessfulAt: params.updatedAt,
  });
}

const newer = {
  sessionId: "session-newer",
  createdAt: "2026-07-13T12:01:00.000Z",
  updatedAt: "2026-07-13T12:05:00.000Z",
  diagram: "newer diagram",
};
const older = {
  sessionId: "session-older",
  createdAt: "2026-07-13T12:00:00.000Z",
  updatedAt: "2026-07-13T12:10:00.000Z",
  diagram: "older diagram",
};

describe("artifacts on disk", () => {
  it("stores a public artifact under its normalized key and reads it back", async () => {
    await expect(write(newer)).resolves.toBe(true);

    const keys = (await listObjects("public", "")).map((o) => o.key);
    expect(keys).toEqual(["public/v1/acme/demo.json"]);
    await expect(
      getStoredDiagramState({ username: "acme", repo: "demo" }),
    ).resolves.toMatchObject({
      diagram: "newer diagram",
      explanation: "newer diagram explanation",
    });
  });

  it("never lets an older session that finishes later overwrite a newer one", async () => {
    const results = await Promise.all([write(newer), write(older)]);

    // Whichever session takes the lock first, the newer one must win.
    expect(results[0]).toBe(true);
    await expect(
      getStoredDiagramState({ username: "acme", repo: "demo" }),
    ).resolves.toMatchObject({ diagram: "newer diagram" });
  });

  it("lets a newer session replace an older artifact", async () => {
    await write(older);

    await expect(write(newer)).resolves.toBe(true);

    await expect(
      getStoredDiagramState({ username: "acme", repo: "demo" }),
    ).resolves.toMatchObject({ diagram: "newer diagram" });
  });

  it("keeps a private artifact in the private bucket, readable only with the same token", async () => {
    await write({
      ...newer,
      visibility: "private",
      githubPat: "ghp_owner",
      repo: "secret",
    });

    await expect(
      getStoredDiagramState({ username: "acme", repo: "secret" }),
    ).resolves.toBeNull();
    await expect(
      getStoredDiagramState({
        username: "acme",
        repo: "secret",
        githubPat: "ghp_other",
      }),
    ).resolves.toBeNull();
    await expect(
      getStoredDiagramState({
        username: "acme",
        repo: "secret",
        githubPat: "ghp_owner",
      }),
    ).resolves.toMatchObject({ diagram: "newer diagram" });
    expect(await listObjects("public", "")).toEqual([]);
    const [privateObject] = await listObjects("private", "");
    expect(privateObject?.key).toMatch(
      /^private\/v1\/[0-9a-f]{64}\/acme\/secret\.json$/,
    );
  });

  it("updates only the session summary of an existing artifact, newest first", async () => {
    await write(older);
    const summary = audit("session-newer", newer.createdAt, newer.updatedAt);

    await expect(
      updateArtifactLatestSessionSummary({
        username: "acme",
        repo: "demo",
        visibility: "public",
        latestSessionSummary: summary,
      }),
    ).resolves.toBe(true);
    await expect(
      updateArtifactLatestSessionSummary({
        username: "acme",
        repo: "missing",
        visibility: "public",
        latestSessionSummary: summary,
      }),
    ).resolves.toBe(false);

    await expect(
      getStoredDiagramState({ username: "acme", repo: "demo" }),
    ).resolves.toMatchObject({
      diagram: "older diagram",
      latestSessionAudit: { sessionId: "session-newer" },
    });
  });
});

describe("public previews on disk", () => {
  it("writes a sidecar only while the matching artifact is canonical, and serves it", async () => {
    await write(newer);

    await expect(
      writePublicDiagramPreview({
        username: "Acme",
        repo: "Demo",
        diagram: "some other diagram",
        lastSuccessfulAt: newer.updatedAt,
      }),
    ).resolves.toBe(false);
    await expect(
      writePublicDiagramPreview({
        username: "Acme",
        repo: "Demo",
        diagram: newer.diagram,
        lastSuccessfulAt: newer.updatedAt,
      }),
    ).resolves.toBe(true);

    expect(
      (await listObjects("public", "public-preview/")).map((o) => o.key),
    ).toEqual(["public-preview/v1/acme/demo.json"]);
    await expect(
      getPublicDiagramPreview({
        username: "acme",
        repo: "demo",
        expectedLastSuccessfulAt: newer.updatedAt,
      }),
    ).resolves.toEqual({
      diagram: newer.diagram,
      lastSuccessfulAt: newer.updatedAt,
      source: "sidecar",
    });
  });

  it("falls back to the artifact when the sidecar is stale or absent", async () => {
    await write(newer);

    await expect(
      getPublicDiagramPreview({
        username: "acme",
        repo: "demo",
        expectedLastSuccessfulAt: newer.updatedAt,
      }),
    ).resolves.toMatchObject({ source: "artifact", diagram: newer.diagram });
    await expect(
      getPublicDiagramPreview({ username: "acme", repo: "nothing" }),
    ).resolves.toBeNull();
  });
});

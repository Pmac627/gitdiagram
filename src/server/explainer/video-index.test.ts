// @vitest-environment node
//
// video-index.ts on SQLite (Phase 5, step 18a). Same exports and signatures;
// the gallery index (one card per repository), the ready flag and the
// build-claim move from a Redis hash and keys into the shared database.
// Semantics preserved from the Lua write script and Redis keys:
//   - one card per repository, keyed by lowercase owner/repo;
//   - "replace" (indexVideo) writes unless the stored card has a NEWER
//     createdAt (ISO strings compare as strings; equal replaces);
//   - "missing" (fillVideoIndex) never overwrites a card written meanwhile;
//   - the index is ready only after a complete fill;
//   - claimVideoIndexBuild: one caller at a time, then not again for 300 s;
//   - indexVideo never throws; readVideoIndex throws when storage fails.
// This replaces the video-index cases in video-state.redis.test.ts and the
// indexVideo cases in catalog.test.ts, which mock Upstash.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { VideoArtifact } from "~/features/explainer/types";
import { closeDb } from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";
import {
  claimVideoIndexBuild,
  fillVideoIndex,
  indexVideo,
  readVideoIndex,
  videoCard,
} from "./video-index";

let dataDir: TempDataDir;

const artifact = (repo: string, createdAt: string, owner = "acme", stars = 1) =>
  ({
    createdAt,
    repository: `${owner}/${repo}`,
    meta: { owner, repo, stars, language: "Go" },
    plan: { title: `${repo} explained`, beats: [{ narration: "Hi." }] },
    timing: { DURATION: 60.4 },
  }) as unknown as VideoArtifact;

beforeEach(async () => {
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await dataDir.dispose();
});

describe("videoCard", () => {
  it("builds a gallery card, with posterAt only when given", () => {
    const video = artifact("widget", "2026-09-01T00:00:00.000Z", "Acme", 7);

    expect(videoCard(video)).toEqual({
      createdAt: "2026-09-01T00:00:00.000Z",
      owner: "Acme",
      repo: "widget",
      title: "widget explained",
      opening: "Hi.",
      durationSeconds: 60,
      stars: 7,
      language: "Go",
    });
    expect(videoCard(video, 5)).toMatchObject({ posterAt: 5 });
  });
});

describe("the gallery index", () => {
  it("starts empty and not ready", async () => {
    await expect(readVideoIndex()).resolves.toEqual({
      ready: false,
      cards: [],
    });
  });

  it("indexes a video, with its poster time", async () => {
    const video = artifact("widget", "2026-09-01T00:00:00.000Z");

    await indexVideo(video, { posterAt: 7 });

    await expect(readVideoIndex()).resolves.toEqual({
      ready: false,
      cards: [videoCard(video, 7)],
    });
  });

  it("keeps one card per repository, ignoring the case of owner and repo", async () => {
    await indexVideo(artifact("Widget", "2026-09-01T00:00:00.000Z", "Acme"));
    await indexVideo(artifact("widget", "2026-09-02T00:00:00.000Z", "acme"));

    const { cards } = await readVideoIndex();

    expect(cards).toHaveLength(1);
    expect(cards[0]?.createdAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("keeps the newest card: a late write for a replaced version never wins", async () => {
    const older = artifact("widget", "2026-09-01T00:00:00.000Z");
    const newer = artifact("widget", "2026-09-02T00:00:00.000Z");

    await indexVideo(newer, { posterAt: 7 });
    await indexVideo(older);

    await expect(readVideoIndex()).resolves.toEqual({
      ready: false,
      cards: [videoCard(newer, 7)],
    });
  });

  it("lets the same version update its card (a remade poster)", async () => {
    const video = artifact("widget", "2026-09-01T00:00:00.000Z");
    await indexVideo(video);

    await indexVideo(video, { posterAt: 99 });

    expect((await readVideoIndex()).cards).toEqual([videoCard(video, 99)]);
  });

  it("compares versions as ISO strings, so a newer year beats a larger month", async () => {
    await indexVideo(artifact("widget", "2027-01-01T00:00:00.000Z"));
    await indexVideo(artifact("widget", "2026-12-31T23:59:59.000Z"));

    expect((await readVideoIndex()).cards[0]?.createdAt).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("survives a reopen of the database", async () => {
    await indexVideo(artifact("widget", "2026-09-01T00:00:00.000Z"));

    closeDb();

    expect((await readVideoIndex()).cards).toHaveLength(1);
  });
});

describe("fillVideoIndex", () => {
  it("never overwrites a card written meanwhile, and adds the missing ones", async () => {
    const newer = artifact("widget", "2026-09-02T00:00:00.000Z");
    const older = artifact("widget", "2026-09-01T00:00:00.000Z");
    await indexVideo(newer, { posterAt: 7 });
    const other = videoCard(artifact("other", "2026-08-01T00:00:00.000Z"));

    await fillVideoIndex([videoCard(older), other], { complete: false });

    const index = await readVideoIndex();
    expect(index.ready).toBe(false);
    expect(index.cards).toHaveLength(2);
    expect(index.cards).toContainEqual(videoCard(newer, 7));
    expect(index.cards).toContainEqual(other);
  });

  it("does not replace a stored card even with a newer one while filling", async () => {
    await indexVideo(artifact("widget", "2026-09-01T00:00:00.000Z"));
    const newerFromStorage = videoCard(
      artifact("widget", "2026-09-05T00:00:00.000Z"),
    );

    await fillVideoIndex([newerFromStorage], { complete: true });

    expect((await readVideoIndex()).cards[0]?.createdAt).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("marks the index ready only after a complete fill", async () => {
    const card = videoCard(artifact("other", "2026-08-01T00:00:00.000Z"));

    await fillVideoIndex([card], { complete: false });
    expect((await readVideoIndex()).ready).toBe(false);

    await fillVideoIndex([card], { complete: true });
    expect(await readVideoIndex()).toEqual({ ready: true, cards: [card] });
  });

  it("can mark ready with no cards, and handles many cards", async () => {
    await fillVideoIndex([], { complete: true });
    expect((await readVideoIndex()).ready).toBe(true);

    const cards = Array.from({ length: 250 }, (_, index) =>
      videoCard(artifact(`repo-${index}`, "2026-08-01T00:00:00.000Z")),
    );
    await fillVideoIndex(cards, { complete: true });

    expect((await readVideoIndex()).cards).toHaveLength(250);
  });
});

describe("claimVideoIndexBuild", () => {
  it("lets one caller build at a time", async () => {
    await expect(claimVideoIndexBuild()).resolves.toBe(true);
    await expect(claimVideoIndexBuild()).resolves.toBe(false);
  });

  it("allows another attempt only five minutes after the last claim", async () => {
    vi.useFakeTimers();
    await claimVideoIndexBuild();

    vi.advanceTimersByTime(299_000);
    await expect(claimVideoIndexBuild()).resolves.toBe(false);

    vi.advanceTimersByTime(2_000);
    await expect(claimVideoIndexBuild()).resolves.toBe(true);
  });
});

describe("storage failures", () => {
  // A DATA_DIR that is a file makes every storage call fail.
  function breakStorage() {
    const broken = path.join(dataDir.path, "not-a-directory");
    writeFileSync(broken, "x");
    process.env.DATA_DIR = broken;
    closeDb();
  }

  it("never throws from indexVideo, and logs why", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    breakStorage();

    await expect(
      indexVideo(artifact("widget", "2026-09-01T00:00:00.000Z")),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("video.index_write_failed"),
    );
  });

  it("throws from readVideoIndex and claimVideoIndexBuild so callers can fall back", async () => {
    breakStorage();

    await expect(readVideoIndex()).rejects.toThrow();
    await expect(claimVideoIndexBuild()).rejects.toThrow();
  });
});

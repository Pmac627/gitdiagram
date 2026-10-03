import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as VideoIndexModule from "./video-index";

const mocks = vi.hoisted(() => ({
  readVideoIndex: vi.fn(),
  claimVideoIndexBuild: vi.fn(),
  fillVideoIndex: vi.fn(),
  listStoredVideos: vi.fn(),
  readVideoArtifact: vi.fn(),
  renderStamp: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>) => read,
}));
vi.mock("./cache", () => ({ VIDEO_CATALOG_TAG: "catalog" }));
// The index itself (SQLite) is covered by video-index.test.ts; here it is a
// fake so the catalog's build-and-fall-back logic is tested on its own.
vi.mock("./video-index", async (importOriginal) => ({
  ...(await importOriginal<typeof VideoIndexModule>()),
  readVideoIndex: mocks.readVideoIndex,
  claimVideoIndexBuild: mocks.claimVideoIndexBuild,
  fillVideoIndex: mocks.fillVideoIndex,
}));
vi.mock("./store", () => ({
  listStoredVideos: mocks.listStoredVideos,
  readVideoArtifact: mocks.readVideoArtifact,
  renderStamp: mocks.renderStamp,
}));

import {
  VIDEO_PAGE_SIZE,
  type VideoCard,
} from "~/features/explainer/catalog-types";
import type { VideoArtifact } from "~/features/explainer/types";
import {
  getFirstVideoPage,
  getVideoPage,
  listVideoCards,
  resetVideoCatalogForTests,
} from "./catalog";
import { videoCard } from "./video-index";

const artifact = (repo: string, createdAt: string, stars = 10) =>
  ({
    createdAt,
    repository: `acme/${repo}`,
    meta: { owner: "Acme", repo, stars, language: "TypeScript" },
    plan: { title: `${repo} explained`, beats: [{ narration: "Hello." }] },
    timing: { DURATION: 61.4 },
  }) as unknown as VideoArtifact;

beforeEach(() => {
  mocks.renderStamp.mockResolvedValue(null);
  resetVideoCatalogForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** A stored video for every name, 400 of them: more than the old 300 cap. */
function storeVideos(count: number) {
  const videos = Array.from({ length: count }, (_, index) =>
    artifact(
      `repo-${index}`,
      new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      index,
    ),
  );
  mocks.listStoredVideos.mockResolvedValue(
    videos.map((video) => ({ owner: "acme", repo: video.meta.repo })),
  );
  mocks.readVideoArtifact.mockImplementation(async (_owner, repo: string) =>
    videos.find((video) => video.meta.repo === repo),
  );
  return videos;
}

/**
 * A video index: whether it is ready, its cards, and whether a build may be
 * claimed.
 */
function videoIndex({
  ready = false,
  cards = [] as VideoCard[],
  claimable = true,
} = {}) {
  mocks.readVideoIndex.mockResolvedValue({ ready, cards });
  mocks.claimVideoIndexBuild.mockResolvedValue(claimable);
  mocks.fillVideoIndex.mockResolvedValue(undefined);
}

describe("the video catalog", () => {
  it("lists every card from the index, newest first, without reading the store", async () => {
    videoIndex({
      ready: true,
      cards: [
        videoCard(artifact("old", "2026-01-01T00:00:00.000Z")),
        videoCard(artifact("new", "2026-09-01T00:00:00.000Z"), 99),
      ],
    });
    const listed = await listVideoCards();
    expect(listed.map((card) => card.repo)).toEqual(["new", "old"]);
    expect(listed[0]!.posterAt).toBe(99);
    expect(mocks.listStoredVideos).not.toHaveBeenCalled();
  });

  it("builds the index from the store once, with every video and its still's stamp", async () => {
    storeVideos(400);
    mocks.renderStamp.mockImplementation(async (video: VideoArtifact) =>
      video.meta.repo === "repo-399" ? 555 : null,
    );
    videoIndex();
    const listed = await listVideoCards();
    expect(listed).toHaveLength(400);
    expect(listed[0]!.repo).toBe("repo-399");
    // Backfilled stills get stamped URLs, like ones indexed as they were made.
    expect(listed[0]!.posterAt).toBe(555);
    expect(listed[1]!.posterAt).toBeUndefined();
    expect(mocks.fillVideoIndex).toHaveBeenCalledTimes(1);
    const [filled, options] = mocks.fillVideoIndex.mock.calls[0]! as [
      VideoCard[],
      { complete: boolean },
    ];
    expect(filled).toHaveLength(400);
    expect(options).toEqual({ complete: true });
  });

  it("leaves the index unready when an artifact could not be read, to build it again later", async () => {
    storeVideos(5);
    const read = mocks.readVideoArtifact.getMockImplementation()!;
    mocks.readVideoArtifact.mockImplementation(async (owner, repo: string) => {
      if (repo === "repo-2") throw new Error("R2 blip");
      return read(owner, repo);
    });
    videoIndex();
    expect(await listVideoCards()).toHaveLength(4);
    // The four it read are indexed, but the index is not marked ready.
    expect(mocks.fillVideoIndex).toHaveBeenCalledTimes(1);
    const [filled, options] = mocks.fillVideoIndex.mock.calls[0]! as [
      VideoCard[],
      { complete: boolean },
    ];
    expect(filled).toHaveLength(4);
    expect(options).toEqual({ complete: false });
    expect(mocks.claimVideoIndexBuild).toHaveBeenCalledTimes(1);
  });

  it("lists what is indexed so far while another build holds the claim", async () => {
    storeVideos(5);
    videoIndex({
      cards: [videoCard(artifact("indexed", "2026-09-01T00:00:00.000Z"))],
      claimable: false,
    });
    const listed = await listVideoCards();
    expect(listed.map((card) => card.repo)).toEqual(["indexed"]);
    expect(mocks.listStoredVideos).not.toHaveBeenCalled();
  });

  it("fails rather than show an empty gallery while the first build runs elsewhere", async () => {
    videoIndex({ claimable: false });
    await expect(listVideoCards()).rejects.toThrow(/being built/);
    await expect(getFirstVideoPage()).rejects.toThrow(/being built/);
  });

  it("still lists everything from the store when the index database is down", async () => {
    storeVideos(320);
    mocks.readVideoIndex.mockRejectedValue(new Error("down"));
    mocks.claimVideoIndexBuild.mockRejectedValue(new Error("down"));
    await expect(listVideoCards()).resolves.toHaveLength(320);
    expect(mocks.fillVideoIndex).not.toHaveBeenCalled();
  });
});

describe("gallery pages", () => {
  const cards = Array.from({ length: 60 }, (_, index) =>
    videoCard(
      artifact(
        `repo-${String(index).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        index * 100,
      ),
    ),
  );

  it("sends one page of cards at a time, newest first by default", async () => {
    videoIndex({ ready: true, cards });
    const first = await getFirstVideoPage();
    expect(first.cards).toHaveLength(VIDEO_PAGE_SIZE);
    expect(first.cards[0]!.repo).toBe("repo-59");
    expect(first).toMatchObject({
      total: 60,
      page: 1,
      pageSize: VIDEO_PAGE_SIZE,
      totalPages: 3,
      sort: "recent_desc",
    });
    expect(first).not.toHaveProperty("items");
  });

  it("searches, sorts and pages like /browse", async () => {
    videoIndex({ ready: true, cards });
    const page = await getVideoPage({
      q: "REPO-5",
      sort: "stars_asc",
      page: "1",
    });
    expect(page.cards.map((card) => card.repo)).toEqual(
      Array.from({ length: 10 }, (_, index) => `repo-5${index}`),
    );
    const last = await getVideoPage({ sort: "name_asc", page: "99" });
    expect(last.page).toBe(3);
    expect(last.cards.map((card) => card.repo)).toEqual(
      Array.from({ length: 12 }, (_, index) => `repo-${48 + index}`),
    );
  });

  it("reads the index once a minute per instance for its pages", async () => {
    videoIndex({ ready: true, cards });
    await getVideoPage({ page: "1" });
    await getVideoPage({ page: "2" });
    expect(mocks.readVideoIndex).toHaveBeenCalledTimes(1);
  });

  it("throws when the videos cannot be listed", async () => {
    mocks.readVideoIndex.mockRejectedValue(new Error("down"));
    mocks.claimVideoIndexBuild.mockRejectedValue(new Error("down"));
    mocks.listStoredVideos.mockRejectedValue(new Error("R2 down"));
    await expect(getVideoPage({})).rejects.toThrow("R2 down");
  });
});

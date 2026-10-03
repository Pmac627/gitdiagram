// @vitest-environment node
//
// browse-diagrams.ts on the object store and SQLite locks (Phase 5, steps 18a
// and 19). These tests run against a real temp DATA_DIR: no R2, Upstash or
// journal mocks.
//
// CONTRACT CHOSEN for "update the browse index on write":
//   - The pending journal (browse-index-pending.ts) is deleted, and with it
//     enqueue/read/acknowledge and `drainPendingBrowseIndex` (and its cron
//     route /api/internal/browse-index/drain, which the implementer removes).
//   - upsertBrowseIndexEntry(entry) is the write path already called after a
//     successful public diagram (diagram-state.ts
//     updatePublicBrowseIndexForSuccessfulDiagram, run from
//     generation-persistence.ts). It now applies the entry straight to the
//     stored index under the "lock:v1:public-browse-index" lock: stage a new
//     snapshot, then commit the manifest with ifMatch (or ifNoneMatch when
//     none exists), retire snapshots beyond the newest 8.
//   - CHANGE: when no index exists at all, upsert CREATES it (a fresh private
//     install has no seeded index). Before, it threw BrowseIndexNotFoundError
//     because the journal needed a canonical baseline. Reads (getBrowsePage,
//     readBrowseIndex) give an empty index when nothing exists.
//   - migrateBrowseIndexToAtomicV3 stays (legacy v1/v2 -> v3) and still
//     requires an existing index.
import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as browseDiagrams from "~/server/storage/browse-diagrams";
import {
  BrowseIndexNotFoundError,
  getBrowsePage,
  migrateBrowseIndexToAtomicV3,
  readBrowseIndex,
  readRecentBrowseIndex,
  RECENT_BROWSE_INDEX_SIZE,
  upsertBrowseIndexEntry,
  type BrowseIndexEntry,
} from "~/server/storage/browse-diagrams";
import { tryDistributedLock } from "~/server/storage/distributed-lock";
import {
  getGzipJsonObject,
  getGzipJsonObjectWithEtag,
  listObjects,
  putGzipJsonObject,
  putJsonObject,
} from "~/server/storage/object-store";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

const BUCKET = "public";
const LEGACY_KEY = "public/v1/_meta/browse-index.json";
const V3_MANIFEST_KEY = "public/v3/_meta/browse-index-manifest.json.gz";
const V3_SNAPSHOT_PREFIX = "public/v3/_meta/browse-index-snapshot-";

let dataDir: TempDataDir;

beforeEach(async () => {
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  await dataDir.dispose();
});

const entry = (
  username: string,
  repo: string,
  lastSuccessfulAt: string,
  stargazerCount: number | null = 1,
): BrowseIndexEntry => ({ username, repo, lastSuccessfulAt, stargazerCount });

const names = (entries: BrowseIndexEntry[]) =>
  entries.map(({ username, repo }) => `${username}/${repo}`);

async function seedAtomicIndex(
  entries: BrowseIndexEntry[],
  generation = "existing-generation",
) {
  const snapshotKey = `${V3_SNAPSHOT_PREFIX}${generation}.json.gz`;
  await putGzipJsonObject(BUCKET, snapshotKey, {
    version: 3,
    generation,
    updatedAt: "2026-03-29T12:00:00.000Z",
    entries,
  });
  await putGzipJsonObject(BUCKET, V3_MANIFEST_KEY, {
    version: 3,
    generation,
    updatedAt: "2026-03-29T12:00:00.000Z",
    snapshotKey,
    retainedSnapshotKeys: [snapshotKey],
    total: entries.length,
    entries: entries.slice(0, RECENT_BROWSE_INDEX_SIZE),
  });

  return snapshotKey;
}

async function seedLegacyIndex(entries: BrowseIndexEntry[]) {
  await putJsonObject(BUCKET, LEGACY_KEY, {
    version: 1,
    updatedAt: "2026-03-29T12:00:00.000Z",
    entries,
  });
}

async function snapshotKeys() {
  return (await listObjects(BUCKET, V3_SNAPSHOT_PREFIX)).map((o) => o.key);
}

describe("the pending journal is gone", () => {
  it("no longer exports a drain, and the journal module is deleted", () => {
    expect(browseDiagrams).not.toHaveProperty("drainPendingBrowseIndex");
    expect(existsSync(path.join(__dirname, "browse-index-pending.ts"))).toBe(
      false,
    );
    expect(
      existsSync(path.join(__dirname, "browse-index-pending.test.ts")),
    ).toBe(false);
  });
});

describe("updating the index on write", () => {
  it("creates the index when none exists: a snapshot first, then the manifest", async () => {
    const entries = await upsertBrowseIndexEntry(
      entry("Acme", "Demo", "2026-03-28T12:00:00.000Z", 42),
    );

    expect(entries).toEqual([
      entry("acme", "demo", "2026-03-28T12:00:00.000Z", 42),
    ]);
    const manifest = await getGzipJsonObject<{
      version: number;
      generation: string;
      snapshotKey: string;
      total: number;
      entries: BrowseIndexEntry[];
      retainedSnapshotKeys: string[];
    }>(BUCKET, V3_MANIFEST_KEY);
    expect(manifest).toMatchObject({ version: 3, total: 1, entries });
    expect(manifest?.snapshotKey).toMatch(
      /^public\/v3\/_meta\/browse-index-snapshot-.+\.json\.gz$/,
    );
    expect(manifest?.retainedSnapshotKeys).toEqual([manifest?.snapshotKey]);
    const snapshot = await getGzipJsonObject<{
      version: number;
      generation: string;
      entries: BrowseIndexEntry[];
    }>(BUCKET, manifest!.snapshotKey);
    expect(snapshot).toMatchObject({
      version: 3,
      generation: manifest?.generation,
      entries,
    });
  });

  it("adds a repository to an existing atomic index, newest first, and serves it", async () => {
    await seedAtomicIndex([
      entry("older", "repo", "2026-03-27T12:00:00.000Z", 5),
    ]);

    const entries = await upsertBrowseIndexEntry(
      entry("acme", "demo", "2026-03-29T12:00:00.000Z", 42),
    );

    expect(names(entries)).toEqual(["acme/demo", "older/repo"]);
    expect(names((await readBrowseIndex())!)).toEqual([
      "acme/demo",
      "older/repo",
    ]);
    expect((await getBrowsePage({})).items[0]).toEqual(
      expect.objectContaining({ username: "acme", repo: "demo" }),
    );
  });

  it("uses the legacy index as its baseline and normalizes it", async () => {
    await seedLegacyIndex([
      entry("Older", "Repo", "2026-03-27T12:00:00.000Z", 5),
    ]);

    const entries = await upsertBrowseIndexEntry(
      entry("Acme", "Demo", "2026-03-28T12:00:00.000Z", 42),
    );

    expect(names(entries)).toEqual(["acme/demo", "older/repo"]);
    expect(await getGzipJsonObject(BUCKET, V3_MANIFEST_KEY)).toMatchObject({
      version: 3,
      total: 2,
    });
  });

  it("commits the manifest against the previous manifest's etag", async () => {
    await seedAtomicIndex([entry("older", "repo", "2026-03-27T12:00:00.000Z")]);
    const before = await getGzipJsonObjectWithEtag(BUCKET, V3_MANIFEST_KEY);

    await upsertBrowseIndexEntry(
      entry("acme", "demo", "2026-03-29T12:00:00.000Z"),
    );

    const after = await getGzipJsonObjectWithEtag(BUCKET, V3_MANIFEST_KEY);
    expect(after?.etag).not.toBe(before?.etag);
    expect(await snapshotKeys()).toHaveLength(2);
  });

  it("does not rewrite the index for a stale update of a repository", async () => {
    await seedAtomicIndex([
      entry("acme", "demo", "2026-03-29T12:00:00.000Z", 42),
    ]);
    const before = await getGzipJsonObjectWithEtag(BUCKET, V3_MANIFEST_KEY);
    const snapshotsBefore = await snapshotKeys();

    const entries = await upsertBrowseIndexEntry(
      entry("acme", "demo", "2026-03-28T12:00:00.000Z", 99),
    );

    expect(entries[0]?.stargazerCount).toBe(42);
    expect(
      (await getGzipJsonObjectWithEtag(BUCKET, V3_MANIFEST_KEY))?.etag,
    ).toBe(before?.etag);
    expect(await snapshotKeys()).toEqual(snapshotsBefore);
  });

  it("replaces a repository's entry with a newer one and fills unknown stars at equal time", async () => {
    await seedAtomicIndex([
      entry("acme", "demo", "2026-03-27T12:00:00.000Z", 5),
    ]);

    await upsertBrowseIndexEntry(
      entry("ACME", "Demo", "2026-03-29T12:00:00.000Z", 42),
    );
    const newer = await readBrowseIndex();
    expect(newer).toEqual([
      entry("acme", "demo", "2026-03-29T12:00:00.000Z", 42),
    ]);

    await upsertBrowseIndexEntry(
      entry("other", "repo", "2026-03-30T12:00:00.000Z", null),
    );
    const entries = await upsertBrowseIndexEntry(
      entry("other", "repo", "2026-03-30T12:00:00.000Z", 7),
    );

    expect(entries.find((e) => e.repo === "repo")?.stargazerCount).toBe(7);
  });

  it("keeps every update when several run at once (serialized by the lock)", async () => {
    await seedAtomicIndex([entry("older", "repo", "2026-03-01T12:00:00.000Z")]);

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        upsertBrowseIndexEntry(
          entry("acme", `repo-${n}`, `2026-03-0${n}T12:00:00.000Z`),
        ),
      ),
    );

    const stored = await readBrowseIndex();
    expect(new Set(names(stored!))).toEqual(
      new Set([
        "older/repo",
        "acme/repo-1",
        "acme/repo-2",
        "acme/repo-3",
        "acme/repo-4",
        "acme/repo-5",
      ]),
    );
    expect(await getGzipJsonObject(BUCKET, V3_MANIFEST_KEY)).toMatchObject({
      total: 6,
    });
  });

  it("retires snapshots beyond the newest eight", async () => {
    for (let n = 0; n < 11; n += 1) {
      await upsertBrowseIndexEntry(
        entry("acme", `repo-${n}`, `2026-03-${10 + n}T12:00:00.000Z`),
      );
    }

    const manifest = await getGzipJsonObject<{
      snapshotKey: string;
      retainedSnapshotKeys: string[];
    }>(BUCKET, V3_MANIFEST_KEY);
    const onDisk = await snapshotKeys();
    expect(manifest?.retainedSnapshotKeys).toHaveLength(8);
    expect(manifest?.retainedSnapshotKeys[0]).toBe(manifest?.snapshotKey);
    expect(new Set(onDisk)).toEqual(new Set(manifest?.retainedSnapshotKeys));
    expect((await readBrowseIndex())!).toHaveLength(11);
  });

  it("waits on the browse-index lock rather than writing around it", async () => {
    await seedAtomicIndex([entry("older", "repo", "2026-03-27T12:00:00.000Z")]);
    const release = await tryDistributedLock({
      key: "lock:v1:public-browse-index",
      ttlMs: 60_000,
    });
    expect(release).not.toBeNull();

    const pending = upsertBrowseIndexEntry(
      entry("acme", "demo", "2026-03-29T12:00:00.000Z"),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await snapshotKeys()).toHaveLength(1);

    await release!();

    await expect(pending).resolves.toHaveLength(2);
  });
});

describe("reading the index", () => {
  it("reads the committed snapshot, ignoring legacy objects", async () => {
    await seedAtomicIndex([
      entry("vercel", "next.js", "2026-03-29T12:00:00.000Z", 130000),
    ]);
    await seedLegacyIndex([
      entry("legacy", "only", "2026-03-01T12:00:00.000Z"),
    ]);

    const result = await getBrowsePage({});

    expect(names(result.items)).toEqual(["vercel/next.js"]);
  });

  it("serves the recent projection from the manifest", async () => {
    const entries = [entry("acme", "demo", "2026-03-29T12:00:00.000Z", 42)];
    await seedAtomicIndex(entries);

    await expect(readRecentBrowseIndex()).resolves.toEqual({
      total: 1,
      entries,
    });
  });

  it("returns null for the recent projection when nothing exists", async () => {
    await expect(readRecentBrowseIndex()).resolves.toBeNull();
    await expect(readBrowseIndex()).resolves.toEqual([]);
  });

  it("falls back to the legacy index", async () => {
    await seedLegacyIndex([
      entry("acme", "demo", "2026-03-29T12:00:00.000Z", 42),
    ]);

    expect((await getBrowsePage({})).items).toHaveLength(1);
  });

  it("supports recent and star sorting, search, filtering, and pagination", async () => {
    await seedLegacyIndex([
      entry("vercel", "next.js", "2026-03-29T12:00:00.000Z", 130000),
      entry("acme", "demo", "2026-03-28T12:00:00.000Z", null),
      entry("vercel", "swr", "2026-03-27T12:00:00.000Z", 32000),
    ]);

    const starsResult = await getBrowsePage({ sort: "stars_desc" });
    const filteredResult = await getBrowsePage({
      q: "vercel",
      sort: "recent_desc",
      page: "2",
    });

    expect(names(starsResult.items)).toEqual([
      "vercel/next.js",
      "vercel/swr",
      "acme/demo",
    ]);
    expect(names(filteredResult.items)).toEqual([
      "vercel/next.js",
      "vercel/swr",
    ]);
    expect(filteredResult.total).toBe(2);
    expect(filteredResult.page).toBe(1);
  });

  it("ignores a legacy minStars parameter and lists null-star entries", async () => {
    await seedLegacyIndex([
      entry("vercel", "next.js", "2026-03-29T12:00:00.000Z", 130000),
      entry("acme", "demo", "2026-03-28T12:00:00.000Z", null),
      entry("acme", "tiny", "2026-03-27T12:00:00.000Z", 0),
    ]);

    const result = await getBrowsePage({ minStars: "100" } as never);

    expect(names(result.items).sort()).toEqual([
      "acme/demo",
      "acme/tiny",
      "vercel/next.js",
    ]);
    expect(result.total).toBe(3);
    expect(result).not.toHaveProperty("minStars");
  });

  // On local disk a missing index means no public diagram was indexed yet
  // (a fresh install, or only private diagrams). Browse shows an empty list.
  it("reads an empty index before any diagram is indexed", async () => {
    await expect(readBrowseIndex()).resolves.toEqual([]);
    await expect(getBrowsePage({ sort: "recent_desc" })).resolves.toMatchObject(
      { items: [] },
    );
  });
});

describe("migrating a legacy index", () => {
  it("writes an atomic snapshot and manifest, normalizing entries", async () => {
    await seedLegacyIndex([
      entry("Acme", "Demo", "2026-03-29T12:00:00.000Z", 42),
    ]);

    await expect(migrateBrowseIndexToAtomicV3()).resolves.toBe(1);

    expect(await getGzipJsonObject(BUCKET, V3_MANIFEST_KEY)).toMatchObject({
      version: 3,
      total: 1,
      entries: [expect.objectContaining({ username: "acme", repo: "demo" })],
    });
  });

  it("keeps only the newest 2000 entries in the recent projection", async () => {
    const many = Array.from({ length: RECENT_BROWSE_INDEX_SIZE + 5 }, (_, n) =>
      entry(
        "acme",
        `repo-${n}`,
        new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
      ),
    );
    await seedLegacyIndex(many);

    await migrateBrowseIndexToAtomicV3();

    const recent = await readRecentBrowseIndex();
    expect(recent?.total).toBe(RECENT_BROWSE_INDEX_SIZE + 5);
    expect(recent?.entries).toHaveLength(RECENT_BROWSE_INDEX_SIZE);
    expect(recent?.entries[0]?.repo).toBe(
      `repo-${RECENT_BROWSE_INDEX_SIZE + 4}`,
    );
  });

  it("does not rewrite an already-atomic index", async () => {
    await seedAtomicIndex([
      entry("acme", "demo", "2026-03-29T12:00:00.000Z", 42),
    ]);
    const before = await getGzipJsonObjectWithEtag(BUCKET, V3_MANIFEST_KEY);

    await expect(migrateBrowseIndexToAtomicV3()).resolves.toBe(1);

    expect(
      (await getGzipJsonObjectWithEtag(BUCKET, V3_MANIFEST_KEY))?.etag,
    ).toBe(before?.etag);
    expect(await snapshotKeys()).toHaveLength(1);
  });

  it("refuses to migrate when there is no index to migrate", async () => {
    await expect(migrateBrowseIndexToAtomicV3()).rejects.toBeInstanceOf(
      BrowseIndexNotFoundError,
    );
    expect(await listObjects(BUCKET, "")).toEqual([]);
  });
});

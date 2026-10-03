import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("~/features/explainer/engine", () => ({ ENGINE_VERSION: "15" }));

import type { VideoArtifact } from "~/features/explainer/types";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";
import * as store from "./store";
import {
  hasRender,
  listStoredVideos,
  readPicture,
  readRender,
  readVideoArtifact,
  readVoiceClip,
  renderStamp,
  staleVideoKeys,
  videoVersion,
  writeRender,
  writeVideo,
} from "./store";
import { readVideoIndex } from "./video-index";

// The video store is local only: files live under DATA_DIR/video, on every
// OS. There is no R2 backend, no VIDEO_STORE switch and no presigned URL.

const artifact = {
  createdAt: "2026-09-24T08:06:45.297Z",
  repository: "Acme/Widget",
  meta: { owner: "Acme", repo: "Widget", stars: 3, language: "Go" },
  plan: { title: "Widget explained", beats: [{ narration: "Hello." }] },
  timing: { DURATION: 60 },
} as unknown as VideoArtifact;
const root = "video/v1/acme/widget";
const current = `${root}/1790237205297`;

describe("explainer video storage keys", () => {
  it("names a video's file folder after its creation time", () => {
    expect(videoVersion("2026-09-24T08:06:45.297Z")).toBe("1790237205297");
    expect(videoVersion("not a date")).toBeNull();
  });

  it("names the files the current version no longer uses, keeping the one it replaced", () => {
    const keys = [
      `${root}/artifact.json`,
      `${current}/beat-00.mp3`,
      `${current}/poster.jpg`,
      `${current}/still.jpg`,
      `${current}/landscape.e15.mp4`,
      `${current}/landscape.e14.mp4`,
      `${current}/vertical.e9.mp4`,
      `${current}/poster.e13.jpg`,
      `${root}/1790000000000/beat-00.mp3`,
      `${root}/1790000000000/landscape.e15.mp4`,
      `${root}/1780000000000/beat-00.mp3`,
      `${root}/1780000000000/beat-01.mp3`,
      `${root}/1770000000000/landscape.e15.mp4`,
    ];

    expect(staleVideoKeys(keys, artifact, "1790000000000")).toEqual([
      `${current}/landscape.e14.mp4`,
      `${current}/vertical.e9.mp4`,
      `${current}/poster.e13.jpg`,
      `${root}/1780000000000/beat-00.mp3`,
      `${root}/1780000000000/beat-01.mp3`,
      `${root}/1770000000000/landscape.e15.mp4`,
    ]);
    // Without knowing what it replaced, only the renders go.
    expect(staleVideoKeys(keys, artifact)).toEqual([
      `${current}/landscape.e14.mp4`,
      `${current}/vertical.e9.mp4`,
      `${current}/poster.e13.jpg`,
    ]);
  });

  it("keeps the published version it replaced, not a newer failed upload", () => {
    // Published A, then B's upload failed before its artifact was written,
    // then C was published: A is what open tabs show, B was never seen.
    const keys = [
      `${root}/1770000000000/beat-00.mp3`,
      `${root}/1780000000000/beat-00.mp3`,
      `${root}/1790000000000/beat-00.mp3`,
      `${current}/beat-00.mp3`,
    ];

    expect(staleVideoKeys(keys, artifact, "1780000000000")).toEqual([
      `${root}/1770000000000/beat-00.mp3`,
      `${root}/1790000000000/beat-00.mp3`,
    ]);
    // With nothing published before, every older folder is left over.
    expect(staleVideoKeys(keys, artifact, null)).toEqual(keys.slice(0, 3));
  });

  it("never names newer files, or another repository's", () => {
    const keys = [
      `${root}/1799999999999/beat-00.mp3`,
      `${current}/landscape.e16.mp4`,
      `${current}/poster.e16.jpg`,
      "video/v1/acme/widget-two/1780000000000/beat-00.mp3",
      "video/v1/acme/widget-two/1770000000000/beat-00.mp3",
      "video/v1/acme/widgetx/artifact.json",
    ];

    expect(staleVideoKeys(keys, artifact, null)).toEqual([]);
  });

  it("only ever recognises forward-slash keys", () => {
    // Keys always use "/", on every OS. A backslash key (what path.join makes
    // on Windows) is not a key at all and is never named for deletion.
    expect(
      staleVideoKeys([`${root}/1780000000000/beat-00.mp3`], artifact, null),
    ).toEqual([`${root}/1780000000000/beat-00.mp3`]);
    expect(
      staleVideoKeys(
        [String.raw`video\v1\acme\widget\1780000000000\beat-00.mp3`],
        artifact,
        null,
      ),
    ).toEqual([]);
  });
});

/** Directory listings normalised to "/", so tests read the same on Windows. */
const posix = (value: string) => value.split(path.sep).join("/");

describe("local video storage", () => {
  let dataDir: TempDataDir;
  // A stand-in working directory: the old store wrote to <cwd>/.video-cache,
  // and this proves the new one writes nowhere near it.
  let cwd: string;
  const version = (createdAt: string) =>
    ({ ...artifact, createdAt }) as VideoArtifact;

  const videoRoot = () => path.join(dataDir.path, "video");

  async function listAll(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true }).catch(
      () => [] as string[],
    );

    return entries.map((entry) => posix(String(entry))).sort();
  }

  /** The folder that holds acme/widget's files, wherever under video/ it is. */
  async function repoDir(): Promise<string> {
    const found = (await listAll(videoRoot())).find((entry) =>
      /(^|\/)v1\/acme\/widget$/.test(entry),
    );

    expect(found, "acme/widget folder under DATA_DIR/video").toBeDefined();

    return path.join(videoRoot(), found!);
  }

  const files = async () => listAll(await repoDir());
  const folderOf = (createdAt: string) => String(Date.parse(createdAt));

  beforeEach(async () => {
    dataDir = await createTempDataDir();
    cwd = await mkdtemp(path.join(tmpdir(), "video-cwd-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await dataDir.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  it("stores under DATA_DIR/video, never in the working directory", async () => {
    await writeVideo(artifact, [Buffer.from("clip")]);

    const stored = await listAll(videoRoot());

    expect(stored.some((entry) => entry.endsWith("artifact.json"))).toBe(true);
    await expect(stat(path.join(cwd, ".video-cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("is local in production too: no R2 backend, no presigned downloads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.VIDEO_STORE;
    delete process.env.R2_PUBLIC_BUCKET;

    await writeVideo(artifact, [Buffer.from("clip")]);

    expect((await readVideoArtifact("Acme", "Widget"))?.createdAt).toBe(
      artifact.createdAt,
    );
    expect(Object.keys(store)).not.toContain("videoStoreBackend");
    expect(Object.keys(store)).not.toContain("renderDownloadUrl");
  });

  it("round-trips the artifact, clips, pictures and renders", async () => {
    const picture = Buffer.from("picture-bytes");
    await writeVideo(
      artifact,
      [Buffer.from("clip-0"), Buffer.from("clip-1")],
      [{ id: "img1", mediaType: "image/png", bytes: picture }],
    );
    await writeRender(artifact, "landscape.mp4", Buffer.from("mp4"));
    await writeRender(artifact, "poster.jpg", Buffer.from("jpg"));

    await expect(readVideoArtifact("acme", "widget")).resolves.toMatchObject({
      createdAt: artifact.createdAt,
    });
    // Owner and repository are matched without regard to case.
    await expect(readVideoArtifact("ACME", "WIDGET")).resolves.not.toBeNull();
    await expect(
      readVoiceClip("Acme", "Widget", artifact.createdAt, 1),
    ).resolves.toEqual(Buffer.from("clip-1"));
    await expect(
      readPicture("Acme", "Widget", artifact.createdAt, "img1"),
    ).resolves.toEqual(picture);
    await expect(readRender(artifact, "landscape.mp4")).resolves.toEqual(
      Buffer.from("mp4"),
    );
    await expect(hasRender(artifact, "poster.jpg")).resolves.toBe(true);
    await expect(hasRender(artifact, "vertical.mp4")).resolves.toBe(false);
    await expect(readRender(artifact, "vertical.mp4")).resolves.toBeNull();
    await expect(
      readVoiceClip("Acme", "Widget", artifact.createdAt, 7),
    ).resolves.toBeNull();
    await expect(readVideoArtifact("nobody", "nothing")).resolves.toBeNull();
  });

  it("names MP4s after the engine version and stamps a render with when it was written", async () => {
    const folder = folderOf(artifact.createdAt);

    await writeRender(artifact, "landscape.mp4", Buffer.from("mp4"));
    await expect(renderStamp(artifact, "poster.jpg")).resolves.toBeNull();

    await writeRender(artifact, "poster.jpg", Buffer.from("jpg"));

    expect(await renderStamp(artifact, "poster.jpg")).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(await files()).toContain(`${folder}/landscape.e15.mp4`);
    expect(await files()).toContain(`${folder}/poster.jpg`);
  });

  it("puts every new video in the gallery index, as production did", async () => {
    await writeVideo(artifact, [Buffer.from("clip")]);

    const index = await readVideoIndex();

    expect(index.cards.map((card) => `${card.owner}/${card.repo}`)).toEqual([
      "Acme/Widget",
    ]);
  });

  it("lists every stored repository with its owner and name decoded", async () => {
    await writeVideo(artifact, [Buffer.from("a")]);
    await writeVideo(
      {
        ...artifact,
        meta: { ...artifact.meta, owner: "Other-Org", repo: "my.repo_1" },
      } as VideoArtifact,
      [Buffer.from("b")],
    );

    const listed = await listStoredVideos();

    expect(listed.map(({ owner, repo }) => `${owner}/${repo}`).sort()).toEqual([
      "acme/widget",
      "other-org/my.repo_1",
    ]);
    for (const entry of listed) {
      expect(entry.updatedAt === null || entry.updatedAt instanceof Date).toBe(
        true,
      );
    }
  });

  it("lists nothing when nothing is stored", async () => {
    await expect(listStoredVideos()).resolves.toEqual([]);
  });

  it("prunes like production, keeping the replaced version, and leaves no temp files", async () => {
    const a = "2026-09-01T00:00:00.000Z";
    const b = "2026-09-02T00:00:00.000Z";
    const c = "2026-09-03T00:00:00.000Z";

    await writeVideo(version(a), [Buffer.from("a")]);
    await writeVideo(version(b), [Buffer.from("b")]);
    await writeVideo(version(c), [Buffer.from("c")]);

    expect(await files()).toEqual([
      folderOf(b),
      `${folderOf(b)}/beat-00.mp3`,
      folderOf(c),
      `${folderOf(c)}/beat-00.mp3`,
      "artifact.json",
    ]);
  });

  it("deletes a failed upload's files but keeps the version tabs still show", async () => {
    const a = "2026-09-01T00:00:00.000Z";
    const b = "2026-09-02T00:00:00.000Z";
    const c = "2026-09-03T00:00:00.000Z";
    await writeVideo(version(a), [Buffer.from("a")]);
    // B's clips were uploaded, but it failed before its artifact was written.
    const orphan = path.join(await repoDir(), folderOf(b));
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, "beat-00.mp3"), "b");

    await writeVideo(version(c), [Buffer.from("c")]);

    expect(await files()).toEqual([
      folderOf(a),
      `${folderOf(a)}/beat-00.mp3`,
      folderOf(c),
      `${folderOf(c)}/beat-00.mp3`,
      "artifact.json",
    ]);
  });

  it("prunes renders an older engine drew once a new MP4 is written", async () => {
    const folder = folderOf(artifact.createdAt);
    await writeVideo(artifact, [Buffer.from("clip")]);
    const directory = path.join(await repoDir(), folder);
    await writeFile(path.join(directory, "landscape.e14.mp4"), "old");
    await writeFile(path.join(directory, "poster.e13.jpg"), "old");

    await writeRender(artifact, "vertical.mp4", Buffer.from("new"));

    const remaining = await files();
    expect(remaining).not.toContain(`${folder}/landscape.e14.mp4`);
    expect(remaining).not.toContain(`${folder}/poster.e13.jpg`);
    expect(remaining).toContain(`${folder}/vertical.e15.mp4`);
  });

  it("leaves no temp file when two writes of one file race", async () => {
    await writeVideo(artifact, [Buffer.from("clip")]);

    await Promise.all([
      writeRender(artifact, "poster.jpg", Buffer.from("one")),
      writeRender(artifact, "poster.jpg", Buffer.from("two")),
    ]);

    expect((await files()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(["one", "two"]).toContain(
      (await readRender(artifact, "poster.jpg"))?.toString(),
    );
  });

  it("rejects an owner or repository that would leave the video folder", async () => {
    const unsafe: Array<[string, string]> = [
      ["..", "widget"],
      ["acme", ".."],
      ["acme/../..", "widget"],
      ["acme", String.raw`a\b`],
      ["", "widget"],
    ];

    for (const [owner, repo] of unsafe) {
      const evil = {
        ...artifact,
        meta: { ...artifact.meta, owner, repo },
      } as VideoArtifact;

      await expect(writeVideo(evil, [Buffer.from("x")])).rejects.toThrow();
      await expect(readVideoArtifact(owner, repo)).rejects.toThrow();
    }

    // Nothing was written anywhere under DATA_DIR/video, or outside it.
    expect(await listAll(videoRoot())).toEqual([]);
    expect(
      (await listAll(dataDir.path)).filter(
        (entry) =>
          !entry.startsWith("gitdiagram.db") &&
          !entry.startsWith("video") &&
          !entry.startsWith("tmp"),
      ),
    ).toEqual([]);
  });
});

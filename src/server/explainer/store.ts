import "server-only";

import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { ENGINE_VERSION } from "~/features/explainer/engine";
import { PICTURE_ID, type VideoArtifact } from "~/features/explainer/types";
import { getDataDir } from "~/server/storage/db";
import { renameWithRetry, toStorageSegment } from "~/server/storage/fs-safety";
import { indexVideo } from "./video-index";

import { errorText } from "~/server/log";
// Explainer videos are files under DATA_DIR/video (keys always use "/", on
// every OS), so they can never collide with a diagram artifact. Everything a
// video references (narration clips, renders) sits under its own version
// folder, so a regenerated video never mixes with the files of the one it
// replaced and every file URL can be cached forever. The version a
// regeneration replaced keeps its files until the next one, so a tab that
// still has it open plays and downloads on; older versions and renders drawn
// by an older engine are deleted (see pruneVideoFiles).

/**
 * One owner or repository name as a folder name. Throws on anything that
 * could leave the video folder or is not a legal file name on Windows.
 */
function segment(value: string): string {
  const encoded = toStorageSegment(value);

  if (!encoded) {
    throw new Error("Invalid video repository name.");
  }

  return encoded;
}

const prefix = (username: string, repo: string) =>
  `video/v1/${segment(username)}/${segment(repo)}`;
const clipName = (index: number) =>
  `beat-${String(index).padStart(2, "0")}.mp3`;
const pictureName = (id: string) => `picture-${id}`;

export type RenderName =
  "landscape.mp4" | "vertical.mp4" | "poster.jpg" | "still.jpg";

// MP4s are drawn by the scene engine, so an engine change makes new ones: the
// engine version is part of their file names. Posters keep one name, since a
// slightly older still beats a missing link preview.
const renderFile = (name: RenderName) =>
  name.endsWith(".mp4")
    ? name.replace(/\.mp4$/, `.e${ENGINE_VERSION}.mp4`)
    : name;

/** A video's version is its creation time; it names the folder its files live in. */
export function videoVersion(createdAt: string): string | null {
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? String(ms) : null;
}

function versionedKey(
  username: string,
  repo: string,
  createdAt: string,
  name: string,
): string {
  const version = videoVersion(createdAt);

  if (!version) {
    throw new Error("Invalid video version.");
  }

  return `${prefix(username, repo)}/${version}/${name}`;
}

/** The file a key names, always inside DATA_DIR. */
function localPath(key: string): string {
  const root = resolve(getDataDir());
  const resolved = resolve(root, ...key.split("/"));

  if (!resolved.startsWith(root + sep)) {
    throw new Error("Invalid video file key.");
  }

  return resolved;
}

async function readObject(key: string): Promise<Buffer | null> {
  try {
    return await readFile(localPath(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeLocal(key: string, body: Buffer | string) {
  const path = localPath(key);
  const tempDir = join(getDataDir(), "tmp");
  // Write then rename so a reader never sees a half-written file; the temp
  // name is unique, so two writes of one file never share it.
  const temp = join(tempDir, `${randomUUID()}.part`);

  try {
    await mkdir(tempDir, { recursive: true });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, body);
    renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readVideoArtifact(
  username: string,
  repo: string,
): Promise<VideoArtifact | null> {
  const body = await readObject(`${prefix(username, repo)}/artifact.json`);

  return body ? (JSON.parse(body.toString("utf8")) as VideoArtifact) : null;
}

export async function readVoiceClip(
  username: string,
  repo: string,
  createdAt: string,
  index: number,
): Promise<Buffer | null> {
  return readObject(versionedKey(username, repo, createdAt, clipName(index)));
}

/** A README picture stored with a video (PNG, JPEG or WebP), by id. */
export async function readPicture(
  username: string,
  repo: string,
  createdAt: string,
  id: string,
): Promise<Buffer | null> {
  if (!PICTURE_ID.test(id)) {
    return null;
  }

  return readObject(versionedKey(username, repo, createdAt, pictureName(id)));
}

/**
 * Clips and pictures first, artifact last: the artifact is what makes a video
 * visible. It is then added to the gallery index, and only after that are
 * files pruned, so nothing indexed points at a deleted file.
 */
export async function writeVideo(
  artifact: VideoArtifact,
  clips: Buffer[],
  pictures: Array<{ id: string; mediaType: string; bytes: Buffer }> = [],
) {
  const { owner, repo } = artifact.meta;
  // Fail fast on a name that cannot be stored, before anything is written.
  const artifactKey = `${prefix(owner, repo)}/artifact.json`;
  const clipKey = (index: number) =>
    versionedKey(owner, repo, artifact.createdAt, clipName(index));
  const pictureKey = (id: string) =>
    versionedKey(owner, repo, artifact.createdAt, pictureName(id));
  // The version this one replaces, read before it is overwritten: its files
  // stay, so tabs still showing it keep working. Null when there is none;
  // undefined when it cannot be read, and then no older folder is pruned.
  const replaced = await readVideoArtifact(owner, repo).then(
    (published) => (published ? videoVersion(published.createdAt) : null),
    () => undefined,
  );

  await Promise.all([
    ...clips.map((clip, index) => writeLocal(clipKey(index), clip)),
    ...pictures.map((p) => writeLocal(pictureKey(p.id), p.bytes)),
  ]);
  await writeLocal(artifactKey, JSON.stringify(artifact));
  await indexVideo(artifact);
  await pruneVideoFiles(artifact, replaced);
}

export async function readRender(
  artifact: VideoArtifact,
  name: RenderName,
): Promise<Buffer | null> {
  const { owner, repo } = artifact.meta;

  return readObject(
    versionedKey(owner, repo, artifact.createdAt, renderFile(name)),
  );
}

export async function hasRender(
  artifact: VideoArtifact,
  name: RenderName,
): Promise<boolean> {
  return (await renderSize(artifact, name)) !== null;
}

/**
 * When a stored render was last written (ms), or null if it does not exist.
 * A poster can be remade under the same name, so its URLs carry this stamp:
 * each remake gets a fresh URL past every cache that kept the old one.
 */
export async function renderStamp(
  artifact: VideoArtifact,
  name: RenderName,
): Promise<number | null> {
  const { owner, repo } = artifact.meta;
  const key = versionedKey(owner, repo, artifact.createdAt, renderFile(name));
  const info = await stat(localPath(key)).catch(() => null);

  return info ? Math.round(info.mtimeMs) : null;
}

/**
 * A stored render's size in bytes, or null when it does not exist. The file
 * route uses it to answer Range requests.
 */
export async function renderSize(
  artifact: VideoArtifact,
  name: RenderName,
): Promise<number | null> {
  const { owner, repo } = artifact.meta;
  const key = versionedKey(owner, repo, artifact.createdAt, renderFile(name));
  const info = await stat(localPath(key)).catch(() => null);

  return info?.isFile() ? info.size : null;
}

/**
 * A stored render as a byte stream (`range` is inclusive), read from disk in
 * chunks so a large MP4 never sits in memory whole. The stream errors if the
 * file disappears before it is read.
 */
export function streamRender(
  artifact: VideoArtifact,
  name: RenderName,
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
  const { owner, repo } = artifact.meta;
  const key = versionedKey(owner, repo, artifact.createdAt, renderFile(name));

  return Readable.toWeb(
    createReadStream(localPath(key), range),
  ) as ReadableStream<Uint8Array>;
}

export async function writeRender(
  artifact: VideoArtifact,
  name: RenderName,
  body: Buffer,
) {
  const { owner, repo } = artifact.meta;
  const key = versionedKey(owner, repo, artifact.createdAt, renderFile(name));

  await writeLocal(key, body);

  // A new MP4 replaces any drawn by an older engine.
  if (name.endsWith(".mp4")) {
    await pruneVideoFiles(artifact);
  }
}

/**
 * Files a video no longer needs: current renders drawn by an older engine,
 * and, given `replaced` (the published version this one replaced, or null if
 * none), every older version's folder but that one's. The replaced version
 * stays so tabs still showing it keep working until the next regeneration;
 * folders of uploads that failed before being published go. Only older
 * files are named, so a server still running an older release during a
 * deploy never deletes a newer one's files.
 */
export function staleVideoKeys(
  keys: string[],
  artifact: VideoArtifact,
  replaced?: string | null,
): string[] {
  const version = videoVersion(artifact.createdAt);

  if (!version) {
    return [];
  }

  const root = `${prefix(artifact.meta.owner, artifact.meta.repo)}/`;
  const engine = Number(ENGINE_VERSION);
  const files = keys.flatMap((key) => {
    if (!key.startsWith(root)) {
      return [];
    }

    const [folder, name, ...rest] = key.slice(root.length).split("/");

    if (!name || rest.length > 0 || !/^\d+$/.test(folder!)) {
      return [];
    }

    return [{ key, folder: folder!, name }];
  });

  return files
    .filter(({ folder, name }) => {
      if (folder !== version) {
        return (
          replaced !== undefined &&
          Number(folder) < Number(version) &&
          folder !== replaced
        );
      }

      const drawn = /\.e(\d+)\.(mp4|jpg)$/.exec(name);

      if (!drawn) {
        return false;
      }

      // Posters no longer carry an engine version, so any that does is left over.
      return drawn[2] === "jpg"
        ? Number(drawn[1]) <= engine
        : Number(drawn[1]) < engine;
    })
    .map(({ key }) => key);
}

async function listVideoKeys(root: string): Promise<string[]> {
  const entries = await readdir(localPath(root), { recursive: true }).catch(
    () => [] as string[],
  );

  return entries.map((entry) => `${root}${entry.split(sep).join("/")}`);
}

/**
 * Delete the files a video no longer uses (see staleVideoKeys); resolves how
 * many went. Never throws: a leftover file only costs storage.
 */
async function pruneVideoFiles(
  artifact: VideoArtifact,
  replaced?: string | null,
): Promise<number> {
  try {
    const root = `${prefix(artifact.meta.owner, artifact.meta.repo)}/`;
    const stale = staleVideoKeys(await listVideoKeys(root), artifact, replaced);

    for (let index = 0; index < stale.length; index += 20) {
      await Promise.all(
        stale
          .slice(index, index + 20)
          .map((key) => rm(localPath(key), { force: true })),
      );
    }

    // Folders emptied by the prune go too (rmdir leaves any in use).
    for (const folder of new Set(stale.map((key) => dirname(key)))) {
      await rmdir(localPath(folder)).catch(() => undefined);
    }

    if (stale.length > 0) {
      console.info(
        JSON.stringify({
          event: "video.pruned",
          repository: artifact.repository,
          files: stale.length,
        }),
      );
    }

    return stale.length;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "video.prune_failed",
        repository: artifact.repository,
        error: errorText(error),
      }),
    );

    return 0;
  }
}

/** Every repository with a stored video, newest first (for the gallery). */
export async function listStoredVideos(): Promise<
  Array<{ owner: string; repo: string; updatedAt: Date | null }>
> {
  const root = join(getDataDir(), "video", "v1");
  const owners = await readdir(root).catch(() => [] as string[]);
  const nested = await Promise.all(
    owners.map(async (owner) => {
      const repos = await readdir(join(root, owner)).catch(
        () => [] as string[],
      );

      return Promise.all(
        repos.map(async (repo) => {
          const info = await stat(
            join(root, owner, repo, "artifact.json"),
          ).catch(() => null);

          return info?.isFile() ? [{ owner, repo, updatedAt: info.mtime }] : [];
        }),
      );
    }),
  );

  return nested
    .flat(2)
    .map(({ owner, repo, updatedAt }) => ({
      owner: decodeURIComponent(owner),
      repo: decodeURIComponent(repo),
      updatedAt: updatedAt as Date | null,
    }))
    .sort(
      (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    );
}

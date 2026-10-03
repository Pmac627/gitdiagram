import "server-only";

import type { VideoCard } from "~/features/explainer/catalog-types";
import type { VideoArtifact } from "~/features/explainer/types";
import { getDb, withImmediateTransaction } from "~/server/storage/db";
import { kvRead, kvWrite, kvWriteIfAbsent } from "~/server/storage/kv";

import { errorText } from "~/server/log";
// /videos and the sitemap list every stored video. Reading every artifact for
// each request would be slow, so the `video_index` table keeps one card per
// repository, written whenever a video or its poster is stored. The table is
// built once from the video store (see catalog.ts); the ready flag says that
// has happened.

const READY_KEY = "video:v1:index:ready";
const BUILD_KEY = "video:v1:index:building";
const BUILD_CLAIM_MS = 5 * 60 * 1000;

const field = (owner: string, repo: string) =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}`;

/** A video's gallery card. */
export function videoCard(
  artifact: VideoArtifact,
  posterAt?: number,
): VideoCard {
  return {
    createdAt: artifact.createdAt,
    owner: artifact.meta.owner,
    repo: artifact.meta.repo,
    title: artifact.plan.title,
    opening: artifact.plan.beats[0]?.narration ?? "",
    durationSeconds: Math.round(artifact.timing.DURATION),
    stars: artifact.meta.stars,
    language: artifact.meta.language,
    ...(posterAt ? { posterAt } : {}),
  };
}

// "replace" writes a card unless the stored one is for a newer version (ISO
// times compare as strings), so a late write for a replaced video never wins;
// "missing" only fills repositories with no card yet, so building the index
// never overwrites a card written meanwhile.
function writeCards(cards: VideoCard[], mode: "replace" | "missing"): void {
  const conflict =
    mode === "replace"
      ? "ON CONFLICT (repo_key) DO UPDATE SET created_at = excluded.created_at, card = excluded.card WHERE video_index.created_at <= excluded.created_at"
      : "ON CONFLICT (repo_key) DO NOTHING";

  withImmediateTransaction((db) => {
    const statement = db.prepare(
      `INSERT INTO video_index (repo_key, created_at, card) VALUES (?, ?, ?) ${conflict}`,
    );

    for (const card of cards) {
      statement.run(
        field(card.owner, card.repo),
        card.createdAt,
        JSON.stringify(card),
      );
    }
  });
}

/**
 * Add or update a video's card (with when its poster was made, once it has
 * one). Never throws: a missing card only hides the video from the gallery
 * until the next write.
 */
export async function indexVideo(
  artifact: VideoArtifact,
  options: { posterAt?: number } = {},
): Promise<void> {
  try {
    writeCards([videoCard(artifact, options.posterAt)], "replace");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "video.index_write_failed",
        repository: artifact.repository,
        error: errorText(error),
      }),
    );
  }
}

/**
 * Every indexed card, and whether the index is complete: until it has been
 * built from storage it may hold only the videos stored since. Throws if the
 * database fails.
 */
export async function readVideoIndex(): Promise<{
  ready: boolean;
  cards: VideoCard[];
}> {
  const db = getDb();
  const ready = kvRead(db, READY_KEY, Date.now()) === "1";
  const rows = db.prepare("SELECT card FROM video_index").all() as Array<{
    card: string;
  }>;
  const cards = rows.flatMap((row) => {
    try {
      return [JSON.parse(row.card) as VideoCard];
    } catch {
      return [];
    }
  });

  return { ready, cards };
}

/**
 * Whether this caller should build the index from storage now: one at a
 * time, and at most once every five minutes, so a storage outage that keeps
 * a build from finishing does not list every object on every request.
 * Throws if the database fails.
 */
export async function claimVideoIndexBuild(): Promise<boolean> {
  return withImmediateTransaction((db) =>
    kvWriteIfAbsent(db, BUILD_KEY, "1", BUILD_CLAIM_MS, Date.now()),
  );
}

/**
 * Add cards read out of storage to the index, never over ones written
 * meanwhile. Only a complete read (every stored video's artifact came back)
 * marks the index ready; until then the next build tries again.
 */
export async function fillVideoIndex(
  cards: VideoCard[],
  { complete }: { complete: boolean },
): Promise<void> {
  writeCards(cards, "missing");

  if (complete) {
    withImmediateTransaction((db) => {
      kvWrite(db, READY_KEY, "1", null, Date.now());
    });
  }
}

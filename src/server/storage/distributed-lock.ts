import { randomUUID } from "node:crypto";

import { getDb, withImmediateTransaction } from "~/server/storage/db";

import { errorText } from "~/server/log";
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes the lock if it is free or expired; true when this token now holds it.
 * The check and the write share one BEGIN IMMEDIATE transaction, so two
 * processes never both win.
 */
function acquire(key: string, token: string, ttlMs: number): boolean {
  const now = Date.now();

  return withImmediateTransaction((db) => {
    db.prepare("DELETE FROM locks WHERE key = ? AND expires_at <= ?").run(
      key,
      now,
    );
    const result = db
      .prepare(
        "INSERT INTO locks (key, token, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING",
      )
      .run(key, token, now + ttlMs);

    return Number(result.changes) === 1;
  });
}

/**
 * Deletes the lock only while this token still holds it, so a holder whose
 * lock expired never frees the next holder's. Never throws: a lock that is
 * not released expires on its own.
 */
async function release(key: string, token: string, failureEvent: string) {
  try {
    getDb()
      .prepare("DELETE FROM locks WHERE key = ? AND token = ?")
      .run(key, token);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: failureEvent,
        lock_key: key,
        error: errorText(error),
      }),
    );
  }
}

/**
 * One holder at a time across every process that shares the database, without
 * waiting: a release function when the lock was free, else null. The lock
 * expires on its own after ttlMs if the holder dies. Throws when the database
 * fails.
 */
export async function tryDistributedLock(params: {
  key: string;
  ttlMs: number;
  /** Logged when releasing fails. */
  releaseFailureEvent?: string;
}): Promise<(() => Promise<void>) | null> {
  if (!params.key) {
    throw new Error("A lock key is required.");
  }

  if (!Number.isFinite(params.ttlMs) || params.ttlMs <= 0) {
    throw new Error("A lock lease must be a positive number of milliseconds.");
  }

  const token = randomUUID();

  if (!acquire(params.key, token, params.ttlMs)) {
    return null;
  }

  return () =>
    release(
      params.key,
      token,
      params.releaseFailureEvent ?? "storage.distributed_lock.release_failed",
    );
}

export async function withDistributedLock<T>(params: {
  key: string;
  callback: () => Promise<T>;
  ttlMs?: number;
  waitMs?: number;
}): Promise<T> {
  if (!params.key) {
    throw new Error("A lock key is required.");
  }

  const token = randomUUID();
  const ttlMs = params.ttlMs ?? 30_000;
  const waitMs = params.waitMs ?? 10_000;
  const deadline = Date.now() + waitMs;

  while (!acquire(params.key, token, ttlMs)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for distributed lock: ${params.key}`);
    }

    await sleep(50 + Math.floor(Math.random() * 100));
  }

  try {
    return await params.callback();
  } finally {
    await release(params.key, token, "storage.distributed_lock.release_failed");
  }
}

import type { DatabaseSync } from "node:sqlite";

// Small key and value rows that can expire, in the shared SQLite database.
// Each helper takes the connection, so a caller can combine several of them in
// one withImmediateTransaction. An expired row reads as missing.

/**
 * The live value for a key. It is null when the key is missing or expired.
 * @see docs/flows/artifact-storage.md
 */
export function kvRead(
  db: DatabaseSync,
  key: string,
  now: number,
): string | null {
  const row = db
    .prepare(
      "SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
    )
    .get(key, now) as { value: string } | undefined;

  return row?.value ?? null;
}

/**
 * Sets a key and replaces the earlier value. A `ttlMs` of null does not expire.
 * @see docs/flows/artifact-storage.md
 */
export function kvWrite(
  db: DatabaseSync,
  key: string,
  value: string,
  ttlMs: number | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
  ).run(key, value, ttlMs === null ? null : now + ttlMs);
}

/**
 * Sets a key only when the key is missing or expired. It gives true when this
 * function wrote the key.
 * @see docs/flows/artifact-storage.md
 */
export function kvWriteIfAbsent(
  db: DatabaseSync,
  key: string,
  value: string,
  ttlMs: number | null,
  now: number,
): boolean {
  db.prepare("DELETE FROM kv WHERE key = ? AND expires_at <= ?").run(key, now);
  const result = db
    .prepare(
      "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING",
    )
    .run(key, value, ttlMs === null ? null : now + ttlMs);

  return Number(result.changes) === 1;
}

/**
 * Deletes a key. A missing key gives no error.
 * @see docs/flows/artifact-storage.md
 */
export function kvRemove(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

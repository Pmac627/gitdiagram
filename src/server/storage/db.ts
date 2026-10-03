import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * File name of the SQLite database in `DATA_DIR`.
 * @see docs/flows/artifact-storage.md
 */
export const DB_FILE_NAME = "gitdiagram.db";

const BUSY_TIMEOUT_MS = 5_000;

/**
 * Versioned migrations. Entry N (numbers start at 1) changes a database from
 * `user_version` N - 1 to N. Do not change an entry after release. Add a new
 * entry.
 * @see docs/flows/artifact-storage.md
 */
const MIGRATIONS: readonly string[] = [
  `
  -- Cross-process locks (distributed-lock.ts): one row per held lock.
  CREATE TABLE locks (
    key        TEXT PRIMARY KEY,
    token      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- Small expiring key/value state (generation cancellation, failure
  -- summaries, the video index ready flag and build claim).
  CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at INTEGER
  ) WITHOUT ROWID;

  -- The /videos gallery index: one card per repository (lowercase owner/repo).
  CREATE TABLE video_index (
    repo_key   TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    card       TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
  `
  -- Videos being paid for right now (explainer/limits.ts); a row whose
  -- expires_at has passed belongs to a run that died and is reclaimed.
  CREATE TABLE IF NOT EXISTS paid_runs (
    token      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- Left over from the live switches, which no longer exist. Nothing reads or
  -- writes this table; migrations are append-only, so it stays for old databases.
  CREATE TABLE IF NOT EXISTS controls (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
];

/**
 * The latest migration number. A current database has this value as its
 * `PRAGMA user_version`.
 * @see docs/flows/artifact-storage.md
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

let handle: DatabaseSync | null = null;
let handleDir: string | null = null;
let transactionDepth = 0;

/**
 * The resolved DATA_DIR. The function reads the value at each call and not at
 * import time. Tests can then switch folders. It throws an Error that names
 * DATA_DIR when the value is not set.
 * @see docs/flows/artifact-storage.md
 */
export function getDataDir(): string {
  const value = process.env.DATA_DIR?.trim();

  if (!value) {
    throw new Error("Missing DATA_DIR.");
  }

  return path.resolve(value);
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const current = row.user_version;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `The database schema version (${current}) is newer than this app supports (${SCHEMA_VERSION}).`,
    );
  }

  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    db.exec("BEGIN IMMEDIATE");

    try {
      // Another process may have migrated while this one waited for the lock.
      const latest = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };

      if (latest.user_version < version) {
        db.exec(MIGRATIONS[version - 1]!);
        db.exec(`PRAGMA user_version = ${version}`);
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function openDatabase(dir: string): DatabaseSync {
  let db: DatabaseSync | null = null;

  try {
    mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(path.join(dir, DB_FILE_NAME));
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);

    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Already unusable; the original error is the useful one.
    }

    // Never put DATA_DIR or an absolute path in the message.
    if (error instanceof Error && /schema version/.test(error.message)) {
      throw new Error(error.message);
    }

    throw new Error("Could not open the application database.");
  }
}

/**
 * The shared SQLite connection for `${DATA_DIR}/gitdiagram.db`. On first use
 * it makes DATA_DIR, sets WAL mode and a busy timeout, and applies the
 * migrations that are due.
 * @see docs/flows/artifact-storage.md
 */
export function getDb(): DatabaseSync {
  const dir = getDataDir();

  if (handle && handleDir === dir) {
    return handle;
  }

  closeDb();
  handle = openDatabase(dir);
  handleDir = dir;

  return handle;
}

/**
 * Closes the shared connection. A second call has no effect. The next
 * `getDb()` opens the database again.
 * @see docs/flows/artifact-storage.md
 */
export function closeDb(): void {
  const open = handle;

  handle = null;
  handleDir = null;
  transactionDepth = 0;

  if (open) {
    try {
      open.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Operates `fn` in a `BEGIN IMMEDIATE` transaction. The write lock starts at
 * the start of the transaction, so other processes must wait. The transaction
 * commits when `fn` gives a value and rolls back when `fn` throws. `fn` must
 * be synchronous. A nested use of this function joins the outer transaction.
 * @see docs/flows/artifact-storage.md
 */
export function withImmediateTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();

  if (transactionDepth > 0) {
    return fn(db);
  }

  db.exec("BEGIN IMMEDIATE");
  transactionDepth = 1;

  try {
    const result = fn(db);

    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      (result as unknown as Promise<unknown>).then(undefined, () => undefined);
      throw new TypeError(
        "withImmediateTransaction needs a synchronous function.",
      );
    }

    db.exec("COMMIT");

    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already be gone (for example after closeDb).
    }

    throw error;
  } finally {
    transactionDepth = 0;
  }
}

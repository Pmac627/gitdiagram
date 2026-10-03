// @vitest-environment node
//
// Contract for src/server/storage/db.ts (Phase 5, step 17). Small on purpose:
//
//   export const DB_FILE_NAME = "gitdiagram.db";
//   export const SCHEMA_VERSION: number;      // latest migration; also PRAGMA user_version
//   export function getDataDir(): string;     // resolved DATA_DIR; throws an Error naming
//                                             // DATA_DIR when it is unset, empty or blank
//   export function getDb(): DatabaseSync;    // node:sqlite handle for `${DATA_DIR}/gitdiagram.db`.
//                                             // Creates DATA_DIR (recursively) if absent, sets WAL
//                                             // and a busy timeout, runs pending migrations.
//                                             // Memoized: same handle while DATA_DIR is unchanged;
//                                             // if process.env.DATA_DIR now points elsewhere the old
//                                             // handle is closed and a new one opened. Never resolved
//                                             // at import time, so tests can switch directories.
//   export function closeDb(): void;          // closes the handle; idempotent; next getDb() reopens
//   export function withImmediateTransaction<T>(fn: (db: DatabaseSync) => T): T;
//                                             // BEGIN IMMEDIATE, COMMIT on return, ROLLBACK on
//                                             // throw (the error is rethrown). fn must be
//                                             // synchronous: a returned promise rolls back and
//                                             // throws a TypeError. A nested call joins the
//                                             // outer transaction (no second BEGIN).
//
// Migrations are versioned with PRAGMA user_version. Opening a database whose
// user_version is newer than SCHEMA_VERSION fails fast (a newer app wrote it).
// Every other storage suite uses createTempDataDir() from ./test-data-dir.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  DB_FILE_NAME,
  getDataDir,
  getDb,
  SCHEMA_VERSION,
  withImmediateTransaction,
} from "~/server/storage/db";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

let dataDir: TempDataDir;

beforeEach(async () => {
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  await dataDir.dispose();
});

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };

  return row.user_version;
}

describe("DATA_DIR handling", () => {
  it("names the file gitdiagram.db", () => {
    expect(DB_FILE_NAME).toBe("gitdiagram.db");
  });

  it.each([undefined, "", "   "])(
    "fails with a clear error when DATA_DIR is %j",
    (value) => {
      if (value === undefined) {
        delete process.env.DATA_DIR;
      } else {
        process.env.DATA_DIR = value;
      }

      expect(() => getDataDir()).toThrow(/DATA_DIR/);
      expect(() => getDb()).toThrow(/DATA_DIR/);
    },
  );

  it("returns the trimmed absolute directory", () => {
    process.env.DATA_DIR = `  ${dataDir.path}  `;

    expect(getDataDir()).toBe(path.resolve(dataDir.path));
  });

  it("creates a missing DATA_DIR, including parents, and the database file", () => {
    const nested = path.join(dataDir.path, "a", "b", "data");
    process.env.DATA_DIR = nested;

    getDb();

    expect(existsSync(path.join(nested, DB_FILE_NAME))).toBe(true);
  });

  it("does not resolve DATA_DIR at import time: switching directories reopens", () => {
    const first = getDb();
    const other = path.join(dataDir.path, "other");
    process.env.DATA_DIR = other;

    const second = getDb();

    // Not `expect(second).not.toBe(first)`: the closed handle cannot be inspected by vitest.
    expect(second === first).toBe(false);
    expect(existsSync(path.join(other, DB_FILE_NAME))).toBe(true);
    expect(() => first.prepare("SELECT 1").get()).toThrow();
  });
});

describe("connection lifecycle", () => {
  it("returns the same handle while DATA_DIR is unchanged", () => {
    expect(getDb()).toBe(getDb());
  });

  it("closeDb is idempotent and the next getDb reopens a working handle", () => {
    const first = getDb();

    closeDb();
    closeDb();

    expect(() => first.prepare("SELECT 1").get()).toThrow();
    expect(getDb().prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });

  it("uses WAL journaling and a busy timeout for overlapping processes", () => {
    const db = getDb();

    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    const timeout = db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(timeout.timeout).toBeGreaterThanOrEqual(1_000);
  });
});

describe("migrations", () => {
  it("records the schema version and creates the schema", () => {
    const db = getDb();

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tables.length).toBeGreaterThan(0);
  });

  it("is idempotent: reopening the same directory changes nothing", () => {
    const first = getDb();
    const before = first
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    first.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)");
    first.exec("INSERT INTO probe (id) VALUES (1)");
    closeDb();

    const second = getDb();

    expect(userVersion(second)).toBe(SCHEMA_VERSION);
    expect(second.prepare("SELECT id FROM probe").all()).toEqual([{ id: 1 }]);
    const after = second
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'probe' ORDER BY name",
      )
      .all();
    expect(after).toEqual(before);
  });

  it("refuses a database written by a newer schema version", () => {
    mkdirSync(dataDir.path, { recursive: true });
    const raw = new DatabaseSync(path.join(dataDir.path, DB_FILE_NAME));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => getDb()).toThrow(/schema|version/i);
  });
});

describe("withImmediateTransaction", () => {
  beforeEach(() => {
    getDb().exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)");
  });

  it("commits when the function returns, and returns its value", () => {
    const result = withImmediateTransaction((db) => {
      db.exec("INSERT INTO probe (id) VALUES (1)");

      return "done";
    });

    expect(result).toBe("done");
    // A second connection only sees committed data.
    const other = new DatabaseSync(path.join(dataDir.path, DB_FILE_NAME));
    expect(other.prepare("SELECT id FROM probe").all()).toEqual([{ id: 1 }]);
    other.close();
  });

  it("rolls back and rethrows the same error when the function throws", () => {
    const failure = new Error("boom");

    expect(() =>
      withImmediateTransaction((db) => {
        db.exec("INSERT INTO probe (id) VALUES (1)");
        throw failure;
      }),
    ).toThrow(failure);

    expect(getDb().prepare("SELECT id FROM probe").all()).toEqual([]);
    // The connection is usable afterwards (no dangling transaction).
    withImmediateTransaction((db) => {
      db.exec("INSERT INTO probe (id) VALUES (2)");
    });
    expect(getDb().prepare("SELECT id FROM probe").all()).toEqual([{ id: 2 }]);
  });

  it("takes the write lock up front: a second connection cannot write meanwhile", () => {
    withImmediateTransaction(() => {
      const other = new DatabaseSync(path.join(dataDir.path, DB_FILE_NAME));
      other.exec("PRAGMA busy_timeout = 0");

      expect(() => other.exec("INSERT INTO probe (id) VALUES (9)")).toThrow(
        /locked|busy/i,
      );

      other.close();
    });
  });

  it("rejects an async function, rolling back its writes", () => {
    expect(() =>
      withImmediateTransaction(((db: DatabaseSync) => {
        db.exec("INSERT INTO probe (id) VALUES (1)");

        return Promise.resolve();
      }) as unknown as (db: DatabaseSync) => void),
    ).toThrow(TypeError);

    expect(getDb().prepare("SELECT id FROM probe").all()).toEqual([]);
  });

  it("lets a nested call join the outer transaction", () => {
    expect(() =>
      withImmediateTransaction((db) => {
        db.exec("INSERT INTO probe (id) VALUES (1)");
        withImmediateTransaction((inner) => {
          inner.exec("INSERT INTO probe (id) VALUES (2)");
        });
        throw new Error("outer fails");
      }),
    ).toThrow("outer fails");

    expect(getDb().prepare("SELECT id FROM probe").all()).toEqual([]);
  });
});

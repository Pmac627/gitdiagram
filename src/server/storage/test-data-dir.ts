// Test helper for every suite that runs against the real SQLite database or
// the object store. Each test gets a fresh, empty DATA_DIR under the OS temp
// folder, so tests never share state and never touch the developer's data.
//
//   let dataDir: TempDataDir;
//   beforeEach(async () => { dataDir = await createTempDataDir(); });
//   afterEach(async () => { await dataDir.dispose(); });
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDb } from "~/server/storage/db";

export interface TempDataDir {
  /** Absolute path; also assigned to `process.env.DATA_DIR`. */
  path: string;
  /** Closes the shared connection, restores DATA_DIR and deletes the folder. */
  dispose(): Promise<void>;
}

export async function createTempDataDir(): Promise<TempDataDir> {
  const previous = process.env.DATA_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "gitdiagram-test-"));
  process.env.DATA_DIR = dir;

  return {
    path: dir,
    async dispose() {
      closeDb();

      if (previous === undefined) {
        delete process.env.DATA_DIR;
      } else {
        process.env.DATA_DIR = previous;
      }

      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

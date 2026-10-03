// @vitest-environment node
//
// Contract for src/server/storage/object-store.ts (Phase 5, step 19). It
// replaces r2.ts for the diagram side: same function names and signatures
// (presign and checkR2Bucket are gone; the video store moves in step 20).
// Objects are files at `${DATA_DIR}/objects/<bucket>/<key>`.
//
//   getJsonObject<T>(bucket, key): Promise<T | null>
//   putJsonObject(bucket, key, payload): Promise<void>
//   getBinaryObject(bucket, key): Promise<Buffer | null>
//   putBinaryObject(bucket, key, body: Buffer, contentType: string): Promise<void>
//   getGzipJsonObject<T>(bucket, key): Promise<T | null>
//   getGzipJsonObjectWithEtag<T>(bucket, key): Promise<ObjectReadResult<T> | null>
//   putGzipJsonObject(bucket, key, payload, condition?: ObjectWriteCondition): Promise<void>
//   getObjectInfo(bucket, key): Promise<{ lastModified: Date | null } | null>
//   hasObject(bucket, key): Promise<boolean>
//   listObjects(bucket, prefix): Promise<Array<{ key; lastModified }>>  // string prefix, ascending keys
//   deleteObject(bucket, key): Promise<void>                            // missing is not an error
//   R2_REQUEST_TIMEOUT_MS                                               // kept: artifact-store sizes its lock from it
//   type ObjectReadResult<T>, type ObjectWriteCondition                 // unchanged
//   class ObjectPreconditionFailedError extends Error { name = "PreconditionFailed" }
//
// Etag: lowercase hex sha256 of the STORED bytes (the gzip bytes for gzip
// objects). Conditional writes (ifNoneMatch / ifMatch) run their check and the
// write inside a SQLite BEGIN IMMEDIATE transaction and finish with a temp
// file plus atomic rename, so no partial file is ever visible.
//
// Key rules (throw an Error matching /invalid object (key|bucket)/i, on reads
// too, before touching the disk): non-empty, "/"-separated segments; a
// segment is not empty, ".", ".." or a Windows device name (con, prn, aux,
// nul, com0-9, lpt0-9, with or without an extension); no leading "/", no
// drive letter ("C:"), no backslash, no NUL, no ASCII control characters, no
// trailing dot or space in a segment, no uppercase ASCII letter. Buckets
// follow the same rules but are a single segment without "/".
//
// CASE DECISION: R2 keys were case-sensitive, NTFS is not. Every key the app
// builds is already lowercase (cache-key.ts normalizeSegment lowercases, the
// private namespace is a hex digest, browse-diagrams.ts uses lowercase
// constants and randomUUID), so the store REJECTS uppercase keys instead of
// letting "a/B.json" and "a/b.json" silently share one file on Windows.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteObject,
  getBinaryObject,
  getGzipJsonObject,
  getGzipJsonObjectWithEtag,
  getJsonObject,
  getObjectInfo,
  hasObject,
  listObjects,
  ObjectPreconditionFailedError,
  putBinaryObject,
  putGzipJsonObject,
  putJsonObject,
} from "~/server/storage/object-store";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

const BUCKET = "test-public-bucket";

let dataDir: TempDataDir;

beforeEach(async () => {
  dataDir = await createTempDataDir();
});

afterEach(async () => {
  await dataDir.dispose();
});

function objectPath(bucket: string, key: string): string {
  return path.join(dataDir.path, "objects", bucket, ...key.split("/"));
}

/** Every file under DATA_DIR/objects, as posix paths relative to it. */
function filesOnDisk(): string[] {
  const root = path.join(dataDir.path, "objects");
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  if (existsSync(root)) {
    visit(root);
  }

  return found.sort();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("json objects", () => {
  it("round-trips a JSON payload and stores it at DATA_DIR/objects/<bucket>/<key>", async () => {
    await putJsonObject(BUCKET, "public/v1/acme/demo.json", {
      hello: "world",
      n: [1, 2],
    });

    await expect(
      getJsonObject(BUCKET, "public/v1/acme/demo.json"),
    ).resolves.toEqual({ hello: "world", n: [1, 2] });
    expect(
      JSON.parse(
        readFileSync(objectPath(BUCKET, "public/v1/acme/demo.json"), "utf8"),
      ),
    ).toEqual({ hello: "world", n: [1, 2] });
  });

  it("returns null for a missing object or bucket", async () => {
    await expect(getJsonObject(BUCKET, "nope.json")).resolves.toBeNull();
    await expect(getJsonObject("other-bucket", "x.json")).resolves.toBeNull();
  });

  it("overwrites an existing object", async () => {
    await putJsonObject(BUCKET, "a.json", { v: 1 });
    await putJsonObject(BUCKET, "a.json", { v: 2 });

    await expect(getJsonObject(BUCKET, "a.json")).resolves.toEqual({ v: 2 });
  });

  it("keeps buckets separate", async () => {
    await putJsonObject("bucket-one", "a.json", { v: 1 });

    await expect(getJsonObject("bucket-two", "a.json")).resolves.toBeNull();
  });

  it("fails without DATA_DIR", async () => {
    delete process.env.DATA_DIR;

    await expect(getJsonObject(BUCKET, "a.json")).rejects.toThrow(/DATA_DIR/);
  });
});

describe("gzip json objects", () => {
  it("round-trips and stores real gzip bytes", async () => {
    await putGzipJsonObject(BUCKET, "meta/index.json.gz", { entries: [1] });

    await expect(
      getGzipJsonObject(BUCKET, "meta/index.json.gz"),
    ).resolves.toEqual({ entries: [1] });
    const raw = readFileSync(objectPath(BUCKET, "meta/index.json.gz"));
    expect(JSON.parse(gunzipSync(raw).toString("utf8"))).toEqual({
      entries: [1],
    });
  });

  it("returns null for a missing object", async () => {
    await expect(getGzipJsonObject(BUCKET, "missing.gz")).resolves.toBeNull();
    await expect(
      getGzipJsonObjectWithEtag(BUCKET, "missing.gz"),
    ).resolves.toBeNull();
  });

  it("returns an etag that is the sha256 of the stored bytes and stable across reads", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { a: 1 });

    const first = await getGzipJsonObjectWithEtag<{ a: number }>(
      BUCKET,
      "m.gz",
    );
    const second = await getGzipJsonObjectWithEtag<{ a: number }>(
      BUCKET,
      "m.gz",
    );

    expect(first?.value).toEqual({ a: 1 });
    expect(first?.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.etag).toBe(sha256(readFileSync(objectPath(BUCKET, "m.gz"))));
    expect(second?.etag).toBe(first?.etag);
  });

  it("changes the etag when the content changes", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { a: 1 });
    const before = await getGzipJsonObjectWithEtag(BUCKET, "m.gz");

    await putGzipJsonObject(BUCKET, "m.gz", { a: 2 });
    const after = await getGzipJsonObjectWithEtag(BUCKET, "m.gz");

    expect(after?.etag).not.toBe(before?.etag);
  });

  it("reads a gzip object that was written by another process", async () => {
    const file = objectPath(BUCKET, "external/x.json.gz");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, gzipSync(JSON.stringify({ ok: true })));

    await expect(
      getGzipJsonObject(BUCKET, "external/x.json.gz"),
    ).resolves.toEqual({ ok: true });
  });
});

describe("binary objects", () => {
  it("round-trips every byte value unchanged", async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

    await putBinaryObject(
      BUCKET,
      "bin/all.bin",
      bytes,
      "application/octet-stream",
    );

    const stored = await getBinaryObject(BUCKET, "bin/all.bin");
    expect(stored?.equals(bytes)).toBe(true);
  });

  it("returns null for a missing object", async () => {
    await expect(getBinaryObject(BUCKET, "bin/none.bin")).resolves.toBeNull();
  });

  it("stores an empty body", async () => {
    await putBinaryObject(
      BUCKET,
      "bin/empty.bin",
      Buffer.alloc(0),
      "text/plain",
    );

    expect((await getBinaryObject(BUCKET, "bin/empty.bin"))?.length).toBe(0);
    await expect(hasObject(BUCKET, "bin/empty.bin")).resolves.toBe(true);
  });
});

describe("info, existence, listing and deletion", () => {
  it("reports info and existence", async () => {
    await expect(getObjectInfo(BUCKET, "a.json")).resolves.toBeNull();
    await expect(hasObject(BUCKET, "a.json")).resolves.toBe(false);

    await putJsonObject(BUCKET, "a.json", {});

    const info = await getObjectInfo(BUCKET, "a.json");
    expect(info?.lastModified).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - info!.lastModified!.getTime())).toBeLessThan(
      60_000,
    );
    expect(
      Math.abs(
        info!.lastModified!.getTime() -
          statSync(objectPath(BUCKET, "a.json")).mtimeMs,
      ),
    ).toBeLessThan(2_000);
    await expect(hasObject(BUCKET, "a.json")).resolves.toBe(true);
  });

  it("does not treat a directory as an object", async () => {
    await putJsonObject(BUCKET, "dir/a.json", {});

    await expect(hasObject(BUCKET, "dir")).resolves.toBe(false);
    await expect(getObjectInfo(BUCKET, "dir")).resolves.toBeNull();
    await expect(getJsonObject(BUCKET, "dir")).resolves.toBeNull();
  });

  it("lists keys by string prefix in ascending order, with forward slashes", async () => {
    await putJsonObject(BUCKET, "public/v1/acme/b.json", {});
    await putJsonObject(BUCKET, "public/v1/acme/a.json", {});
    await putJsonObject(BUCKET, "public/v1/acorn/x.json", {});
    await putJsonObject(BUCKET, "public/v2/z.json", {});
    await putJsonObject("another-bucket", "public/v1/acme/c.json", {});

    const acme = await listObjects(BUCKET, "public/v1/acme/");
    const partial = await listObjects(BUCKET, "public/v1/ac");
    const everything = await listObjects(BUCKET, "");

    expect(acme.map((item) => item.key)).toEqual([
      "public/v1/acme/a.json",
      "public/v1/acme/b.json",
    ]);
    expect(partial.map((item) => item.key)).toEqual([
      "public/v1/acme/a.json",
      "public/v1/acme/b.json",
      "public/v1/acorn/x.json",
    ]);
    expect(everything).toHaveLength(4);
    expect(acme[0]?.lastModified).toBeInstanceOf(Date);
  });

  it("lists nothing for a missing bucket or prefix", async () => {
    await expect(listObjects("no-such-bucket", "")).resolves.toEqual([]);
    await putJsonObject(BUCKET, "a.json", {});
    await expect(listObjects(BUCKET, "zzz/")).resolves.toEqual([]);
  });

  it("deletes an object, and deleting a missing one is not an error", async () => {
    await putJsonObject(BUCKET, "a.json", {});

    await deleteObject(BUCKET, "a.json");
    await deleteObject(BUCKET, "a.json");
    await deleteObject("no-such-bucket", "a.json");

    await expect(getJsonObject(BUCKET, "a.json")).resolves.toBeNull();
    await expect(listObjects(BUCKET, "")).resolves.toEqual([]);
  });
});

describe("conditional writes", () => {
  it("ifNoneMatch succeeds when the object is absent", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { v: 1 }, { ifNoneMatch: true });

    await expect(getGzipJsonObject(BUCKET, "m.gz")).resolves.toEqual({ v: 1 });
  });

  it("ifNoneMatch fails when the object exists, leaving it unchanged", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { v: 1 });

    await expect(
      putGzipJsonObject(BUCKET, "m.gz", { v: 2 }, { ifNoneMatch: true }),
    ).rejects.toBeInstanceOf(ObjectPreconditionFailedError);

    await expect(getGzipJsonObject(BUCKET, "m.gz")).resolves.toEqual({ v: 1 });
    expect(new ObjectPreconditionFailedError().name).toBe("PreconditionFailed");
  });

  it("ifMatch succeeds with the current etag and returns a new etag afterwards", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { v: 1 });
    const current = await getGzipJsonObjectWithEtag(BUCKET, "m.gz");

    await putGzipJsonObject(
      BUCKET,
      "m.gz",
      { v: 2 },
      { ifMatch: current!.etag },
    );

    const next = await getGzipJsonObjectWithEtag<{ v: number }>(BUCKET, "m.gz");
    expect(next?.value).toEqual({ v: 2 });
    expect(next?.etag).not.toBe(current?.etag);
  });

  it("ifMatch fails on a stale etag, leaving the object unchanged", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { v: 1 });
    const stale = await getGzipJsonObjectWithEtag(BUCKET, "m.gz");
    await putGzipJsonObject(BUCKET, "m.gz", { v: 2 });

    await expect(
      putGzipJsonObject(BUCKET, "m.gz", { v: 3 }, { ifMatch: stale!.etag }),
    ).rejects.toBeInstanceOf(ObjectPreconditionFailedError);

    await expect(getGzipJsonObject(BUCKET, "m.gz")).resolves.toEqual({ v: 2 });
  });

  it("ifMatch fails when the object does not exist", async () => {
    await expect(
      putGzipJsonObject(BUCKET, "m.gz", { v: 1 }, { ifMatch: "0".repeat(64) }),
    ).rejects.toBeInstanceOf(ObjectPreconditionFailedError);

    await expect(hasObject(BUCKET, "m.gz")).resolves.toBe(false);
  });

  it("lets exactly one of several concurrent ifNoneMatch writers win", async () => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((v) =>
        putGzipJsonObject(BUCKET, "race.gz", { v }, { ifNoneMatch: true }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
  });

  it("lets exactly one of several concurrent ifMatch writers win", async () => {
    await putGzipJsonObject(BUCKET, "race.gz", { v: 0 });
    const current = await getGzipJsonObjectWithEtag(BUCKET, "race.gz");

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((v) =>
        putGzipJsonObject(BUCKET, "race.gz", { v }, { ifMatch: current!.etag }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("atomic writes", () => {
  it("leaves only the object itself on disk after a success", async () => {
    await putJsonObject(BUCKET, "a/b.json", { v: 1 });
    await putGzipJsonObject(
      BUCKET,
      "a/c.json.gz",
      { v: 1 },
      { ifNoneMatch: true },
    );
    await putBinaryObject(BUCKET, "a/d.bin", Buffer.from("x"), "text/plain");

    expect(filesOnDisk()).toEqual([
      `${BUCKET}/a/b.json`,
      `${BUCKET}/a/c.json.gz`,
      `${BUCKET}/a/d.bin`,
    ]);
    expect((await listObjects(BUCKET, "")).map((o) => o.key)).toEqual([
      "a/b.json",
      "a/c.json.gz",
      "a/d.bin",
    ]);
  });

  it("leaves no temp file after a failed precondition", async () => {
    await putGzipJsonObject(BUCKET, "m.gz", { v: 1 });

    await expect(
      putGzipJsonObject(BUCKET, "m.gz", { v: 2 }, { ifNoneMatch: true }),
    ).rejects.toThrow();

    expect(filesOnDisk()).toEqual([`${BUCKET}/m.gz`]);
  });

  it("keeps the previous object and leaves no temp file when the payload cannot be written", async () => {
    await putJsonObject(BUCKET, "a.json", { v: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(putJsonObject(BUCKET, "a.json", circular)).rejects.toThrow();
    await expect(
      putGzipJsonObject(BUCKET, "a.json", { big: BigInt(1) }),
    ).rejects.toThrow();

    await expect(getJsonObject(BUCKET, "a.json")).resolves.toEqual({ v: 1 });
    expect(filesOnDisk()).toEqual([`${BUCKET}/a.json`]);
  });

  it("does not expose a half-written object to concurrent readers", async () => {
    const big = { text: "x".repeat(2_000_000) };
    await putJsonObject(BUCKET, "a.json", { text: "old" });

    const writes = putJsonObject(BUCKET, "a.json", big);
    const reads = await Promise.all(
      Array.from({ length: 20 }, () =>
        getJsonObject<{ text: string }>(BUCKET, "a.json"),
      ),
    );
    await writes;

    for (const read of reads) {
      expect(["old", big.text]).toContain(read?.text);
    }
  });
});

describe("key and bucket validation", () => {
  const badKeys: Array<[string, string]> = [
    ["empty", ""],
    ["parent segment", "../evil.json"],
    ["embedded parent segment", "public/../../evil.json"],
    ["trailing parent segment", "public/.."],
    ["current-directory segment", "public/./a.json"],
    ["absolute path", "/etc/passwd"],
    ["drive letter with slash", "C:/Windows/evil.json"],
    ["drive letter without slash", "C:evil.json"],
    ["backslash separator", "public\\evil.json"],
    ["backslash traversal", "..\\evil.json"],
    ["NUL byte", "public/a\0.json"],
    ["control character", "public/a\n.json"],
    ["empty segment", "public//a.json"],
    ["trailing slash", "public/a/"],
    ["trailing dot in a segment", "public/a./b.json"],
    ["trailing space in a segment", "public/a /b.json"],
    ["Windows device name", "public/con"],
    ["Windows device name with extension", "public/acme/nul.json"],
    [
      "uppercase letters (case-insensitive filesystem)",
      "public/Acme/demo.json",
    ],
  ];

  it.each(badKeys)("rejects a key with %s", async (_label, key) => {
    await expect(putJsonObject(BUCKET, key, {})).rejects.toThrow(
      /invalid object key/i,
    );
    await expect(getJsonObject(BUCKET, key)).rejects.toThrow(
      /invalid object key/i,
    );
    await expect(hasObject(BUCKET, key)).rejects.toThrow(/invalid object key/i);
    await expect(deleteObject(BUCKET, key)).rejects.toThrow(
      /invalid object key/i,
    );
    await expect(
      putGzipJsonObject(BUCKET, key, {}, { ifNoneMatch: true }),
    ).rejects.toThrow(/invalid object key/i);
  });

  it("writes nothing outside the objects root for a traversal attempt", async () => {
    await expect(
      putJsonObject(BUCKET, "../../evil.json", {}),
    ).rejects.toThrow();

    expect(existsSync(path.join(dataDir.path, "evil.json"))).toBe(false);
    expect(existsSync(path.join(dataDir.path, "objects", "evil.json"))).toBe(
      false,
    );
    expect(filesOnDisk()).toEqual([]);
  });

  it("accepts the keys the application really builds", async () => {
    const keys = [
      "public/v1/acme/demo.json",
      "public/v1/vercel/next.js.json",
      "public/v1/acme/my_repo-2.json",
      "public-preview/v1/acme/demo.json",
      "public/v3/_meta/browse-index-snapshot-1b671a64-40d5-491e-99b0-da01ff1f3341.json.gz",
      `private/v1/${"ab".repeat(32)}/acme/demo.json`,
    ];

    for (const key of keys) {
      await putJsonObject(BUCKET, key, { key });
      await expect(getJsonObject(BUCKET, key)).resolves.toEqual({ key });
    }
  });

  it("treats keys that differ only by case as invalid rather than sharing one file", async () => {
    await putJsonObject(BUCKET, "public/v1/acme/demo.json", { v: 1 });

    await expect(
      putJsonObject(BUCKET, "public/v1/ACME/demo.json", { v: 2 }),
    ).rejects.toThrow(/invalid object key/i);

    await expect(
      getJsonObject(BUCKET, "public/v1/acme/demo.json"),
    ).resolves.toEqual({ v: 1 });
  });

  const badBuckets: Array<[string, string]> = [
    ["empty", ""],
    ["a dot", "."],
    ["a parent segment", ".."],
    ["a slash", "a/b"],
    ["a backslash", "a\\b"],
    ["a drive letter", "C:"],
    ["a NUL byte", "a\0b"],
    ["a traversal", "../x"],
    ["an absolute path", "/abs"],
    ["uppercase letters", "Bucket"],
    ["a Windows device name", "nul"],
  ];

  it.each(badBuckets)("rejects a bucket that is %s", async (_label, bucket) => {
    await expect(putJsonObject(bucket, "a.json", {})).rejects.toThrow(
      /invalid object bucket/i,
    );
    await expect(getJsonObject(bucket, "a.json")).rejects.toThrow(
      /invalid object bucket/i,
    );
    await expect(listObjects(bucket, "")).rejects.toThrow(
      /invalid object bucket/i,
    );
  });

  it("accepts ordinary bucket names", async () => {
    for (const bucket of ["test-public-bucket", "gitdiagram_private", "b.v2"]) {
      await putJsonObject(bucket, "a.json", {});
      await expect(hasObject(bucket, "a.json")).resolves.toBe(true);
    }
  });
});

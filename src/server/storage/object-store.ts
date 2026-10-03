import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { getDataDir, withImmediateTransaction } from "./db";
import { isValidSegment, renameWithRetry } from "./fs-safety";

/**
 * The maximum time of one small storage request when objects were in R2.
 * The value stays because artifact-store uses it for the lock lease.
 * @see docs/flows/artifact-storage.md
 */
export const R2_REQUEST_TIMEOUT_MS = 10_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/**
 * A decoded object and its etag, the SHA-256 digest of the stored bytes.
 * @see docs/flows/artifact-storage.md
 */
export interface ObjectReadResult<T> {
  value: T;
  etag: string;
}

/**
 * A condition for a write: the etag that must be there (`ifMatch`), or no
 * object at all (`ifNoneMatch`).
 * @see docs/flows/artifact-storage.md
 */
export type ObjectWriteCondition = { ifMatch: string } | { ifNoneMatch: true };

/**
 * Thrown when an `ifMatch` or `ifNoneMatch` condition does not hold.
 * @see docs/flows/artifact-storage.md
 */
export class ObjectPreconditionFailedError extends Error {
  constructor() {
    super("The object changed since it was read.");
    this.name = "PreconditionFailed";
  }
}

function assertValidBucket(bucket: string): void {
  if (
    typeof bucket !== "string" ||
    bucket.includes("/") ||
    !isValidSegment(bucket)
  ) {
    throw new Error("Invalid object bucket.");
  }
}

function assertValidKey(key: string): string[] {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Invalid object key.");
  }

  const segments = key.split("/");

  if (!segments.every(isValidSegment)) {
    throw new Error("Invalid object key.");
  }

  return segments;
}

function bucketRoot(bucket: string): string {
  assertValidBucket(bucket);

  return path.join(getDataDir(), "objects", bucket);
}

function objectPath(bucket: string, key: string): string {
  assertValidBucket(bucket);

  const segments = assertValidKey(key);
  const root = bucketRoot(bucket);
  const resolved = path.join(root, ...segments);

  // Defense in depth: validation already forbids every way out of the root.
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid object key.");
  }

  return resolved;
}

function etagOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The stored bytes, or null when there is no such file (a directory is none).
 * @see docs/flows/artifact-storage.md
 */
function readStored(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    const code = errorCode(error);

    if (code && MISSING_CODES.has(code)) {
      return null;
    }

    // Windows reports EPERM for reading a directory.
    if (code === "EPERM" && isDirectory(file)) {
      return null;
    }

    throw error;
  }
}

/**
 * Writes `body` to the object. The condition check and the write are in one
 * `BEGIN IMMEDIATE` transaction, and other processes also use this lock. The
 * bytes go to a temp file, and an atomic rename moves the file to the object.
 */
function writeStored(
  bucket: string,
  key: string,
  body: Buffer,
  condition?: ObjectWriteCondition,
): void {
  const file = objectPath(bucket, key);
  const tempDir = path.join(getDataDir(), "tmp");
  const tempFile = path.join(tempDir, `${randomUUID()}.part`);

  try {
    withImmediateTransaction(() => {
      if (condition) {
        const existing = readStored(file);
        const failed =
          "ifNoneMatch" in condition
            ? existing !== null
            : existing === null || etagOf(existing) !== condition.ifMatch;

        if (failed) {
          throw new ObjectPreconditionFailedError();
        }
      }

      mkdirSync(tempDir, { recursive: true });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(tempFile, body);
      renameWithRetry(tempFile, file);
    });
  } finally {
    rmSync(tempFile, { force: true });
  }
}

/**
 * Reads a JSON object. It gives null when the object is missing or empty.
 * @see docs/flows/artifact-storage.md
 */
export async function getJsonObject<T>(
  bucket: string,
  key: string,
): Promise<T | null> {
  const bytes = readStored(objectPath(bucket, key));

  if (!bytes || bytes.byteLength === 0) {
    return null;
  }

  return JSON.parse(bytes.toString("utf8")) as T;
}

/**
 * Writes a JSON object with a temp file and an atomic rename.
 * @see docs/flows/artifact-storage.md
 */
export async function putJsonObject(
  bucket: string,
  key: string,
  payload: unknown,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");

  writeStored(bucket, key, body);
}

/**
 * Reads the stored bytes of an object, or null when it is missing.
 * @see docs/flows/artifact-storage.md
 */
export async function getBinaryObject(
  bucket: string,
  key: string,
): Promise<Buffer | null> {
  return readStored(objectPath(bucket, key));
}

/**
 * Writes the stored bytes of an object with an atomic rename.
 * @see docs/flows/artifact-storage.md
 */
export async function putBinaryObject(
  bucket: string,
  key: string,
  body: Buffer,
  // The content type is not stored; the file name decides it on the way out.
  _contentType: string,
): Promise<void> {
  writeStored(bucket, key, body);
}

/**
 * Reads and decompresses a gzip JSON object, or null when it is missing.
 * @see docs/flows/artifact-storage.md
 */
export async function getGzipJsonObject<T>(
  bucket: string,
  key: string,
): Promise<T | null> {
  return (await getGzipJsonObjectWithEtag<T>(bucket, key))?.value ?? null;
}

/**
 * Reads a gzip JSON object with its etag. It gives null when the object is
 * missing or empty.
 * @see docs/flows/artifact-storage.md
 */
export async function getGzipJsonObjectWithEtag<T>(
  bucket: string,
  key: string,
): Promise<ObjectReadResult<T> | null> {
  const bytes = readStored(objectPath(bucket, key));

  if (!bytes || bytes.byteLength === 0) {
    return null;
  }

  const decompressed = await gunzipAsync(bytes);

  return {
    value: JSON.parse(decompressed.toString("utf8")) as T,
    etag: etagOf(bytes),
  };
}

/**
 * Writes a gzip JSON object. With a condition, the check and the write are in
 * one `BEGIN IMMEDIATE` transaction. A condition that does not hold causes
 * `ObjectPreconditionFailedError`.
 * @see docs/flows/artifact-storage.md
 */
export async function putGzipJsonObject(
  bucket: string,
  key: string,
  payload: unknown,
  condition?: ObjectWriteCondition,
): Promise<void> {
  // Validate before compressing so a bad key fails fast.
  assertValidBucket(bucket);
  assertValidKey(key);

  const body = await gzipAsync(JSON.stringify(payload));

  writeStored(bucket, key, body, condition);
}

/**
 * The last-modified time of an object, or null when the object is not there.
 * @see docs/flows/artifact-storage.md
 */
export async function getObjectInfo(
  bucket: string,
  key: string,
): Promise<{ lastModified: Date | null } | null> {
  const file = objectPath(bucket, key);

  try {
    const stats = statSync(file);

    return stats.isFile() ? { lastModified: stats.mtime } : null;
  } catch (error) {
    const code = errorCode(error);

    if (code && MISSING_CODES.has(code)) {
      return null;
    }

    throw error;
  }
}

/**
 * Gives `true` when the object has a file.
 * @see docs/flows/artifact-storage.md
 */
export async function hasObject(bucket: string, key: string): Promise<boolean> {
  return (await getObjectInfo(bucket, key)) !== null;
}

/**
 * All keys that start with `prefix`, in ascending order, with the time of
 * the last change of each.
 * @see docs/flows/artifact-storage.md
 */
export async function listObjects(
  bucket: string,
  prefix: string,
): Promise<Array<{ key: string; lastModified: Date | null }>> {
  const root = bucketRoot(bucket);
  const slash = prefix.lastIndexOf("/");
  const directoryPart = slash >= 0 ? prefix.slice(0, slash) : "";
  const startSegments = directoryPart ? directoryPart.split("/") : [];

  // No valid key can pass through an invalid segment, so nothing can match.
  if (!startSegments.every(isValidSegment)) {
    return [];
  }

  const found: Array<{ key: string; lastModified: Date | null }> = [];
  const visit = (directory: string, keyPrefix: string): void => {
    let entries;

    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);

      if (code && MISSING_CODES.has(code)) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const key = `${keyPrefix}${entry.name}`;

      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), `${key}/`);
      } else if (entry.isFile() && key.startsWith(prefix)) {
        found.push({
          key,
          lastModified: statSync(path.join(directory, entry.name)).mtime,
        });
      }
    }
  };

  visit(
    path.join(root, ...startSegments),
    startSegments.length > 0 ? `${startSegments.join("/")}/` : "",
  );

  return found.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

/**
 * Deletes an object. A missing object gives no error.
 * @see docs/flows/artifact-storage.md
 */
export async function deleteObject(bucket: string, key: string): Promise<void> {
  const file = objectPath(bucket, key);

  try {
    unlinkSync(file);
  } catch (error) {
    const code = errorCode(error);

    // A missing object (or a directory at that path) is not an error.
    if (
      (code && MISSING_CODES.has(code)) ||
      (code === "EPERM" && isDirectory(file))
    ) {
      return;
    }

    throw error;
  }
}

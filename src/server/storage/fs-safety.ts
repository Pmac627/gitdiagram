import { renameSync } from "node:fs";

// File-name rules and the atomic-rename function for the object store and the
// video store. The two stores use one definition of a safe name.

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;
// Control characters, DEL, backslash, uppercase ASCII and characters that are
// illegal or special in Windows file names (":" also starts an NTFS stream).
const FORBIDDEN_SEGMENT_CHARACTER = /[\u0000-\u001f\u007f\\A-Z:<>"|?*]/;
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * True when a name is a reserved Windows device name: con, prn, aux, nul,
 * com0 to com9, or lpt0 to lpt9. An extension and uppercase letters do not
 * change the result. Windows does not accept such a name as a file or folder
 * name.
 * @see docs/flows/artifact-storage.md
 */
export function isWindowsDeviceName(name: string): boolean {
  return WINDOWS_DEVICE_NAME.test(name.toLowerCase());
}

/**
 * True when one path segment is safe as a file or folder name on all systems.
 * The segment is not empty and is not a dot segment. It has no final dot or
 * space. It has no uppercase letter, so two names do not change only by
 * letter case. It has no character that Windows rejects. It is not a Windows
 * device name.
 * @see docs/flows/artifact-storage.md
 */
export function isValidSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    !FORBIDDEN_SEGMENT_CHARACTER.test(segment) &&
    !WINDOWS_DEVICE_NAME.test(segment)
  );
}

/**
 * An owner or repository name as a folder name. The function trims the name,
 * changes it to lowercase, and escapes it. The hex digits of each %XX escape
 * are lowercase too, because Windows ignores letter case in names. The result
 * is null when the name has a slash or a backslash, or is not a valid segment
 * (see isValidSegment).
 * @see docs/flows/artifact-storage.md
 */
export function toStorageSegment(value: string): string | null {
  if (typeof value !== "string" || /[\\/]/.test(value)) {
    return null;
  }

  const encoded = encodeURIComponent(value.trim().toLowerCase()).replace(
    /%[0-9A-F]{2}/g,
    (escape) => escape.toLowerCase(),
  );

  return isValidSegment(encoded) ? encoded : null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames a file. It tries again, five times maximum, when Windows refuses to
 * replace a file that a reader has open (EPERM, EBUSY, EACCES).
 * @see docs/flows/artifact-storage.md
 */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);

      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;

      if (attempt >= 5 || !code || !RENAME_RETRY_CODES.has(code)) {
        throw error;
      }

      sleepSync(20 * attempt);
    }
  }
}

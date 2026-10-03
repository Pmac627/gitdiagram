import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

function sourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      sourceFiles(full, files);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }

  return files;
}

describe("browser calls to the operator-gated API", () => {
  // Every /api route needs the operator session cookie. A fetch that omits
  // credentials gets a 401 from the gate (upstream used "omit" so a public CDN
  // could cache the answers).
  it("never leave out the session cookie", () => {
    const offenders = sourceFiles(path.join(root, "src"))
      .filter((file) =>
        /credentials:\s*["']omit["']/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(root, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });
});

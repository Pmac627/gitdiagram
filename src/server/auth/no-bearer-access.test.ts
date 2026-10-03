import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Source check in the style of fork-isolation.test.ts. The Professor decided
// on 2026-09-30 that the operator signs in with a session cookie only. No
// production source may read an inbound Authorization header, and the Bearer
// helper must stay deleted. Outbound calls (GitHub, OpenRouter) that build an
// `authorization:` header are fine: they never call `headers.get`.

const root = path.resolve(__dirname, "../../..");

function sourceFiles(directory: string, files: string[] = []): string[] {
  if (!existsSync(directory)) {
    return files;
  }

  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);

    if (statSync(full).isDirectory()) {
      sourceFiles(full, files);
      continue;
    }

    const relative = path.relative(root, full).split(path.sep).join("/");

    if (
      /\.(?:ts|tsx|js|mjs)$/.test(name) &&
      !/\.test\.[cm]?[jt]sx?$/.test(name) &&
      !relative.includes("/test/")
    ) {
      files.push(relative);
    }
  }

  return files;
}

function offenders(patterns: RegExp[]): string[] {
  return sourceFiles(path.join(root, "src"))
    .filter((file) => {
      const content = readFileSync(path.join(root, file), "utf8");

      return patterns.some((pattern) => pattern.test(content));
    })
    .sort();
}

describe("no Bearer access for the operator", () => {
  it("has no verifyOperatorBearer", () => {
    expect(offenders([/verifyOperatorBearer/])).toEqual([]);
  });

  it("reads no inbound Authorization header", () => {
    expect(
      offenders([
        /headers\s*\.\s*get\(\s*["'`]authorization["'`]/i,
        /headers\s*\[\s*["'`]authorization["'`]\s*\]/i,
        /startsWith\(\s*["'`]Bearer\b/i,
        /\/\^?\s*Bearer\\s/i,
      ]),
    ).toEqual([]);
  });
});

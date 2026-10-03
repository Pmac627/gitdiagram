import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..", "..");
const PACKAGE = "@sparticuz/chromium";

function walk(directory: string, files: string[]): string[] {
  if (!existsSync(directory)) {
    return files;
  }

  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== ".next") {
        walk(full, files);
      }
    } else {
      files.push(full);
    }
  }

  return files;
}

describe("Chromium comes from VIDEO_RENDER_CHROME_PATH only", () => {
  it("references @sparticuz/chromium nowhere in src, next.config.js or package.json", () => {
    const files = [
      ...walk(path.join(root, "src"), []).filter(
        (file) =>
          /\.[cm]?[jt]sx?$/.test(file) &&
          !file.endsWith("no-vercel-chromium.test.ts"),
      ),
      path.join(root, "next.config.js"),
      path.join(root, "package.json"),
    ];
    const offenders = files
      .filter((file) => readFileSync(file, "utf8").includes(PACKAGE))
      .map((file) => path.relative(root, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });

  it("render.ts has no VERCEL branch", () => {
    const source = readFileSync(
      path.join(root, "src/server/explainer/render.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/process\.env\.VERCEL/);
  });
});

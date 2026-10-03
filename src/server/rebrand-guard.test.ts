import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const srcRoot = path.join(root, "src");

// Static scan of non-test source. LICENSE, README.md, docs/, experiments/
// and plans/ are outside src/ and are deliberately not scanned. JSON
// fixtures are skipped. The binary src/app/opengraph-image.png cannot be
// scanned; the implementer must check it by eye.
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".css"]);

function isTestFile(relative: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(relative) || relative.includes("/test/");
}

function sourceFiles(): Array<{ relative: string; text: string }> {
  const out: Array<{ relative: string; text: string }> = [];

  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full).split(path.sep).join("/");

      if (statSync(full).isDirectory()) {
        if (name === "__fixtures__" || name === "node_modules") {
          continue;
        }

        walk(full);
        continue;
      }

      if (scannedExtensions.has(path.extname(name)) && !isTestFile(relative)) {
        out.push({ relative, text: readFileSync(full, "utf8") });
      }
    }
  };

  walk(srcRoot);

  return out;
}

function filesMatching(pattern: RegExp, allowed: string[] = []): string[] {
  return sourceFiles()
    .filter(
      ({ relative, text }) => !allowed.includes(relative) && pattern.test(text),
    )
    .map(({ relative }) => relative);
}

describe("rebrand guard: no upstream promotion in source", () => {
  it("deletes the star reminder hook and the upstream star-count fetch", () => {
    expect(existsSync(path.join(root, "src/hooks/useStarReminder.tsx"))).toBe(
      false,
    );
    expect(existsSync(path.join(root, "src/server/github-stars.ts"))).toBe(
      false,
    );
  });

  it("references the star reminder or the star-count module nowhere", () => {
    expect(
      filesMatching(
        /useStarReminder|hasShownStarReminder|star-reminder-toast|github-stars/,
      ),
    ).toEqual([]);
  });

  it("references gitdiagram.com nowhere (the public service is not this fork)", () => {
    expect(filesMatching(/gitdiagram\.com/)).toEqual([]);
  });

  it("references the upstream author's website, social handle or sponsor pages nowhere", () => {
    // Found by grep: ahmedkhaleel.com (footer.tsx); @ahmedkhaleel2004 as
    // twitter creator in layout.tsx, reels/page.tsx, videos/page.tsx,
    // [username]/[repo]/page.tsx and [username]/[repo]/video/page.tsx; and
    // the author entry https://github.com/ahmedkhaleel2004 plus the keyword
    // "ahmed khaleel" in layout.tsx. No sponsor URLs exist in src today.
    expect(
      filesMatching(
        /ahmedkhaleel\.com|@ahmedkhaleel2004|github\.com\/sponsors|ahmed khaleel/i,
      ),
    ).toEqual([]);
  });

  it("names the upstream account only in the credit constant and the example repo list", () => {
    // site.ts holds the one upstream credit URL; exampleRepos.ts lists the
    // public repository /ahmedkhaleel2004/gitdiagram as a browse example.
    expect(
      filesMatching(/ahmedkhaleel2004/, [
        "src/lib/site.ts",
        "src/lib/exampleRepos.ts",
      ]),
    ).toEqual([]);
  });

  it("uses the upstream repository URL constant only in the footer", () => {
    // credential-dialog.tsx and header-client.tsx link to it today.
    expect(
      filesMatching(/GITHUB_REPO_URL/, [
        "src/lib/site.ts",
        "src/components/footer.tsx",
      ]),
    ).toEqual([]);
  });

  it("keeps the per-repository star lookup the video planner needs", () => {
    const github = readFileSync(
      path.join(root, "src/server/generate/github.ts"),
      "utf8",
    );

    expect(github).toMatch(/stargazer/i);
  });

  it("claims no gitdiagram.com service in OG image code", () => {
    const og = sourceFiles().filter(
      ({ relative }) =>
        relative.startsWith("src/server/og/") ||
        /opengraph-image/.test(relative),
    );

    expect(og.length).toBeGreaterThan(0);

    for (const { text } of og) {
      expect(text).not.toMatch(/gitdiagram\.com/);
    }
  });
});

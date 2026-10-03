import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

/**
 * Source check for step 27. A server log line that carries error or upstream
 * text must pass it through `redactLogText` (or `errorText`, which applies it).
 *
 * Why this pattern: the leaks are never in the log call's shape but in what it
 * interpolates. Three things carry upstream text into a log line:
 *   1. `.message` of a caught error (provider, GitHub and storage SDKs echo
 *      keys, tokens and request headers in it),
 *   2. `.text()` of a failed response (the raw body), and
 *   3. `raw_error`, the field name the stream route uses for the original text.
 * A bare `, error)` argument (logging the whole error object) carries the same
 * text plus a stack. So the check finds every `console.*(` and `logEvent(`
 * call, reads it to its balanced closing parenthesis, and requires a redaction
 * call inside whenever one of those four carriers appears. Fixed strings,
 * numbers and headers such as `x-github-request-id` do not match, so they need
 * no wrapper. A call that uses `errorText(` has no `.message` left to match.
 */
const UPSTREAM_CARRIER =
  /\braw_error\b|\.message\b|\.text\(\)|,\s*error\s*\)|\bbody\s*:/;
const REDACTION_CALL = /\b(?:redactLogText|errorText)\(/;
const LOG_CALL = /\b(?:console\.(?:error|warn|info|log)|logEvent)\(/g;

const scannedRoots = ["src/server", "src/app/api"];
// The helper lives here, and client components are not server logs.
const EXCLUDED = new Set(["src/server/log.ts"]);

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes("/test/");
}

function walk(directory: string, files: string[]): void {
  if (!existsSync(directory)) {
    return;
  }

  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    const relative = path.relative(root, full).split(path.sep).join("/");

    if (statSync(full).isDirectory()) {
      walk(full, files);
      continue;
    }

    if (
      /\.tsx?$/.test(name) &&
      !isTestFile(relative) &&
      !EXCLUDED.has(relative)
    ) {
      files.push(relative);
    }
  }
}

/** The text of a call from its opening parenthesis to the balanced close. */
function callText(source: string, openIndex: number): string {
  let depth = 0;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
  }

  return source.slice(openIndex);
}

function unredactedLogCalls(): string[] {
  const files: string[] = [];

  for (const scanned of scannedRoots) {
    walk(path.join(root, scanned), files);
  }

  const offenders: string[] = [];

  for (const file of files.sort()) {
    const source = readFileSync(path.join(root, file), "utf8");

    for (const match of source.matchAll(LOG_CALL)) {
      const open = match.index + match[0].length - 1;
      const call = callText(source, open);

      if (UPSTREAM_CARRIER.test(call) && !REDACTION_CALL.test(call)) {
        const line = source.slice(0, match.index).split("\n").length;

        offenders.push(`${file}:${line}`);
      }
    }
  }

  return offenders;
}

describe("log redaction: no log line carries upstream text unscrubbed", () => {
  it("passes every error message, response body and raw_error through redactLogText", () => {
    const offenders = unredactedLogCalls();

    expect(
      offenders,
      `These log calls include upstream or error text without redactLogText or errorText:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("exports redactLogText from src/server/log.ts", () => {
    const source = readFileSync(path.join(root, "src/server/log.ts"), "utf8");

    expect(/export function redactLogText\(/.test(source)).toBe(true);
    expect(source.includes("redactSecrets")).toBe(true);
  });

  it("wires the five named sites to the helper", () => {
    for (const [file, event] of [
      ["src/app/api/generate/stream/route.ts", "raw_error"],
      ["src/app/api/generate/cost/route.ts", "generate.cost.failed"],
      ["src/server/generate/github.ts", "generate.github.request_failed"],
      ["src/server/github-auth.ts", "github_auth.installation_token_failed"],
    ] as const) {
      const source = readFileSync(path.join(root, file), "utf8");

      expect(source.includes(event), `${file} logs ${event}`).toBe(true);
      expect(/redactLogText\(/.test(source), `${file} uses redactLogText`).toBe(
        true,
      );
    }
  });
});

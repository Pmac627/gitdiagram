import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

/**
 * Legitimate exceptions, keyed by forward-slash path relative to the repo
 * root. Each value lists the check names that may match in that file. Keep
 * this list as small as possible and explain every entry.
 */
const ALLOWLIST: Record<string, string[]> = {
  // The README image filter skips sponsor logos and badges on purpose. It is
  // about third-party README content, not the removed sponsor system.
  "src/server/explainer/readme-images.ts": ["sponsor"],
  // The video prompts tell the models never to show a README's sponsor
  // pictures. The same third-party content, the second layer of that filter.
  "src/server/explainer/shot-prompt.ts": ["sponsor"],
};

const skippedDirectories = new Set(["node_modules", ".next", ".git"]);
const scannedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".html",
]);

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes("/test/");
}

function walk(directory: string, files: string[]): void {
  if (!existsSync(directory)) {
    return;
  }

  for (const name of readdirSync(directory)) {
    if (skippedDirectories.has(name)) {
      continue;
    }

    const full = path.join(directory, name);
    const relative = path.relative(root, full).split(path.sep).join("/");

    if (statSync(full).isDirectory()) {
      if (relative === "public/video-engine/assets/vendor") {
        continue;
      }

      walk(full, files);
      continue;
    }

    if (scannedExtensions.has(path.extname(name)) && !isTestFile(relative)) {
      files.push(relative);
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];

  walk(path.join(root, "src"), files);
  walk(path.join(root, "public"), files);

  for (const single of ["next.config.js", "package.json", ".env.example"]) {
    if (existsSync(path.join(root, single))) {
      files.push(single);
    }
  }

  return files;
}

function readManifest(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
}

function dependencyNames(): string[] {
  const manifest = readManifest();

  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
}

function offenders(checkName: string, patterns: RegExp[]): string[] {
  return collectFiles()
    .filter((file) => !(ALLOWLIST[file] ?? []).includes(checkName))
    .filter((file) => {
      const content = readFileSync(path.join(root, file), "utf8");

      return patterns.some((pattern) => pattern.test(content));
    })
    .sort();
}

function expectNoReferences(checkName: string, patterns: RegExp[]): void {
  const found = offenders(checkName, patterns);

  expect(
    found,
    `Files still reference removed "${checkName}" code:\n${found.join("\n")}`,
  ).toEqual([]);
}

describe("fork isolation: removed features leave no references", () => {
  it("has no PostHog references", () => {
    expectNoReferences("posthog", [
      /posthog/i,
      /\/phx9a/,
      /NEXT_PUBLIC_POSTHOG_KEY/,
      /POSTHOG_PERSONAL_API_KEY/,
    ]);
  });

  it("has no sponsor references", () => {
    expectNoReferences("sponsor", [
      /sponsor/i,
      /["'`]\/out\//,
      /gd_sponsor_visitor/,
    ]);
  });

  it("has no live-presence references", () => {
    expectNoReferences("presence", [
      /NEXT_PUBLIC_PRESENCE_URL/,
      /PRESENCE_SECRET/,
      /live-presence/,
      /emitLiveEvent/,
      /presence-protocol/,
    ]);
  });

  it("has no Claude credit panel references", () => {
    expectNoReferences("claude-credit", [
      /claude-credit/,
      /ANTHROPIC_ADMIN_KEY/,
    ]);
  });

  it("does not depend on posthog-js", () => {
    expect(dependencyNames()).not.toContain("posthog-js");
  });

  // Phase 3: the public-service machinery (quotas, limiters, audience rules,
  // the visitor cookie) is gone. Patterns name imports, not English words, so
  // an unrelated "audience" or "rate limit" in a comment or a string is fine.
  it("has no complimentary-gate or quota-store references", () => {
    expectNoReferences("complimentary-quota", [
      /complimentary-gate/,
      /quota-store/,
      /\bComplimentary(Quota|Gate|Admission)/,
      /\b(admit|finalize|mark)Complimentary/,
      /\bOPENAI_COMPLIMENTARY_/,
      /complimentary-quota-today/,
      /quota:today/,
    ]);
  });

  it("has no generation rate-limit references", () => {
    expectNoReferences("generation-rate-limit", [
      /from\s+["'][^"']*\/rate-limit["']/,
      /import\(\s*["'][^"']*\/rate-limit["']\s*\)/,
      /\b(consume|refund)Generation(Infrastructure)?RateLimit\b/,
      /\bGENERATION_RATE_LIMIT_/,
      /\bGENERATION_INFRASTRUCTURE_RATE_LIMIT_/,
    ]);
  });

  it("has no audience, priority-place, limited-country or geo references", () => {
    expectNoReferences("audience-geo", [
      /from\s+["'](?:~\/server\/explainer|\.)\/audience["']/,
      /priority-places/,
      /limited-countries/,
      /vercel-geo/,
      /\brequestGeo\b/,
      /\b(audienceBlock|limitedCountryRule|isInVideoRegion|anyDeviceHere)\b/,
      /\bVIDEO_PREVIEW_PAUSED=audience/,
    ]);
  });

  it("has no video visitor cookie references", () => {
    expectNoReferences("visitor-cookie", [
      /from\s+["'](?:~\/server\/explainer|\.)\/visitor["']/,
      /\bgd_visitor\b/,
      /\bVISITOR_COOKIE\b/,
      /\b(readVisitor|withVisitorCookie)\b/,
    ]);
  });

  it("has no per-person, per-network, premium-quota, attempt or render budgets", () => {
    expectNoReferences("video-budgets", [
      /\b(reserveVideoSlot|takePremiumVideo|takeVideoAttempt|reserveRenderSlot)\b/,
      /\b(videoLimitReached|videoUsageToday|resetUsageToday)\b/,
      /\b(limitMessage|attemptLimitMessage|renderLimitMessage)\b/,
    ]);
  });

  it("names none of the environment variables the removed modules read", () => {
    // Read from: rate-limit.ts (the first four), complimentary-gate.ts (the
    // OPENAI_COMPLIMENTARY_ ones) and limits.ts / admin/controls.ts (VIDEO_*).
    // VIDEO_MAX_PAID_RUNS, VIDEO_PREMIUM_MIN_STARS and
    // VIDEO_PREMIUM_OPUS_DESIGNS stay: the concurrency cap and the planner
    // still read them.
    const removedVariables = [
      "GENERATION_RATE_LIMIT_MAX",
      "GENERATION_RATE_LIMIT_WINDOW_SECONDS",
      "GENERATION_INFRASTRUCTURE_RATE_LIMIT_MAX",
      "GENERATION_INFRASTRUCTURE_RATE_LIMIT_WINDOW_SECONDS",
      "OPENAI_COMPLIMENTARY_GATE_ENABLED",
      "OPENAI_COMPLIMENTARY_DAILY_LIMIT_TOKENS",
      "OPENAI_COMPLIMENTARY_MODEL_FAMILY",
      "VIDEO_DAILY_LIMIT",
      "VIDEO_PERSON_DAILY_LIMIT",
      "VIDEO_PRIORITY_PERSON_DAILY_LIMIT",
      "VIDEO_PREMIUM_PERSON_DAILY_LIMIT",
      "VIDEO_PREMIUM_NETWORK_DAILY_LIMIT",
      "VIDEO_NETWORK_DAILY_LIMIT",
      "VIDEO_NETWORK_ATTEMPT_LIMIT",
      "VIDEO_NETWORK_ATTEMPT_WINDOW_SECONDS",
      "VIDEO_RENDER_DAILY_LIMIT",
      "VIDEO_RENDER_PERSON_DAILY_LIMIT",
      "VIDEO_RENDER_NETWORK_DAILY_LIMIT",
    ];

    expectNoReferences(
      "removed-env-vars",
      removedVariables.map((name) => new RegExp(`\\b${name}\\b`)),
    );
  });

  it("keeps the environment variables the surviving code still reads", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");

    for (const name of [
      "VIDEO_MAX_PAID_RUNS",
      "VIDEO_PREMIUM_MIN_STARS",
      "VIDEO_ADMIN_TOKEN",
    ]) {
      expect(example, `${name} must stay in .env.example`).toContain(name);
    }
  });

  // Phase 3: the Vercel and container deployment recipes are gone.
  it("has no Vercel functions, cache-tag, CDN-header or deployment-pinning references", () => {
    expectNoReferences("vercel", [
      /@vercel\/functions/,
      /dangerouslyDeleteByTag/,
      /\bpurgeVideoResponse\b/,
      /\bvideoResponseTag\b/,
      /x-vercel-/i,
      /Vercel-Cache-Tag/i,
      /Vercel-CDN-Cache-Control/i,
      /\bCDN-Cache-Control\b/i,
      /x-deployment-id/i,
      /\bVERCEL_DEPLOYMENT_ID\b/,
      /\b(deploymentHeaders|pinToDeployment)\b/,
      /searchParams\.(?:set|get|append|has)\(\s*["']dpl["']/,
      /[?&]dpl=/,
    ]);
  });

  it("does not depend on @vercel/functions and has no quota:today script", () => {
    expect(dependencyNames()).not.toContain("@vercel/functions");
    expect(Object.keys(readManifest().scripts ?? {})).not.toContain(
      "quota:today",
    );
  });

  it("runs no docker build in CI", () => {
    const workflow = path.join(root, ".github/workflows/ci.yml");

    if (!existsSync(workflow)) {
      return;
    }

    const content = readFileSync(workflow, "utf8");

    expect(content).not.toMatch(/docker\s+build/i);
    expect(content).not.toMatch(/\bDockerfile\b/);
    expect(content).not.toMatch(/railway/i);
  });

  // Phase 5 and Phase 4 (step 15): Redis and R2 are gone, including the two
  // operator-login modules that used Upstash before they moved to SQLite.
  function importsFrom(...specifiers: string[]): string[] {
    return collectFiles().filter((file) => {
      const content = readFileSync(path.join(root, file), "utf8");

      return specifiers.some((specifier) => content.includes(specifier));
    });
  }

  function importsOf(moduleName: string): string[] {
    const pattern = new RegExp(
      String.raw`(?:from\s+|import\(\s*)["'](?:~/server/storage/|\./|\.\./storage/)` +
        moduleName +
        String.raw`["']`,
    );

    return collectFiles().filter((file) =>
      pattern.test(readFileSync(path.join(root, file), "utf8")),
    );
  }

  it("imports the Upstash client nowhere", () => {
    expect(importsOf("upstash")).toEqual([]);
  });

  it("has no Upstash or Redis client code, variables or dependencies", () => {
    expectNoReferences("upstash", [
      /\bUPSTASH_[A-Z_]+/,
      /@upstash\//,
      /\bupstash(Command|Eval|Pipeline)\b/,
    ]);
    expect(
      dependencyNames().filter((name) => /upstash|^redis$/.test(name)),
    ).toEqual([]);
  });

  it("lists no UPSTASH_* variable in .env.example", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");

    expect(example).not.toMatch(/UPSTASH_/);
  });

  // Phase 4: one operator token guards everything.
  it("documents OPERATOR_TOKEN in .env.example", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");

    expect(example).toMatch(/^#?\s*OPERATOR_TOKEN=/m);
  });

  it("keeps the operator login modules under src/server/auth", () => {
    for (const file of [
      "src/server/auth/operator.ts",
      "src/server/auth/sign-in-guard.ts",
      "src/server/auth/require-operator.ts",
    ]) {
      expect(existsSync(path.join(root, file)), `${file} must exist`).toBe(
        true,
      );
    }

    expect(
      importsFrom("~/server/admin/operator", "~/server/admin/sign-in-guard"),
      "nothing imports the old admin auth modules",
    ).toEqual([]);
  });

  it("imports the R2 client nowhere", () => {
    expect(importsOf("r2")).toEqual([]);
  });

  it("does not depend on the S3 SDK", () => {
    const names = dependencyNames();

    expect(names).not.toContain("@aws-sdk/client-s3");
    expect(names).not.toContain("@aws-sdk/s3-request-presigner");
    expect(names.filter((name) => name.startsWith("@aws-sdk/"))).toEqual([]);
  });

  it("reads no R2 bucket override, VIDEO_STORE or presigned-download code", () => {
    expectNoReferences("r2-and-video-store", [
      /\bR2_PUBLIC_BUCKET\b/,
      /\bR2_PRIVATE_BUCKET\b/,
      /\bVIDEO_STORE\b/,
      /\bvideoStoreBackend\b/,
      /\bpresignObjectDownload\b/,
      /\brenderDownloadUrl\b/,
    ]);
  });

  it("lists no R2_* or VIDEO_STORE variable in .env.example", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");

    expect(example).not.toMatch(/\bR2_[A-Z_]+/);
    expect(example).not.toMatch(/\bVIDEO_STORE\b/);
  });

  it("has no legacy quota fields or repair-token option left in the code", () => {
    expectNoReferences("legacy-audit-fields", [
      /\bquotaStatus\b/,
      /\bquotaBucket\b/,
      /\bquotaDateUtc\b/,
      /\bactualCommittedTokens\b/,
      /\bquotaResetAt\b/,
      /\bincludeGraphRepairInputTokens\b/,
    ]);
  });

  // Phase 4 decision (1), the Professor, 2026-09-30: the `videosPaused` switch
  // is gone, and with it the live-controls module, its route and the panel's
  // props. The `controls` table stays in the schema (migrations are
  // append-only, and dropping it would be destructive), but nothing reads or
  // writes it.
  it("has no pause switch, live-controls module or controls API", () => {
    expectNoReferences("pause-switch", [
      /\bvideosPaused\b/,
      /\bLiveControls\b/,
      /\bDEFAULT_CONTROLS\b/,
      /\b(readAdmissionControls|readControlsForDisplay|writeControls|ControlsUnconfirmedError)\b/,
      /\bcontrolsUnreadable\b/,
      /admin\/controls/,
      /\badmin\.controls\./,
    ]);
  });

  it("has only the voice reason left in pausedMessage", () => {
    const limits = readFileSync(
      path.join(root, "src/server/explainer/limits.ts"),
      "utf8",
    );

    expect(limits).toMatch(/export function pausedMessage\(/);
    expect(limits).not.toMatch(/["']paused["']\s*\|/);
    expect(limits).not.toMatch(/paused for now/);
  });

  it("reads and writes the controls table nowhere, while the migration keeps it", () => {
    expectNoReferences("controls-table", [
      /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+controls\b/i,
    ]);

    const db = readFileSync(
      path.join(root, "src/server/storage/db.ts"),
      "utf8",
    );

    // Append-only migrations: the table is still created for old databases.
    expect(db).toMatch(/CREATE TABLE IF NOT EXISTS controls\b/);
  });

  const removedPaths = [
    "src/server/admin/controls.ts",
    "src/server/admin/controls.test.ts",
    "src/app/api/admin/controls",
    "src/server/storage/upstash.ts",
    "src/server/storage/upstash.test.ts",
    "src/server/admin/operator.ts",
    "src/server/admin/operator.test.ts",
    "src/server/admin/sign-in-guard.ts",
    "src/server/admin/sign-in-guard.redis.test.ts",
    "src/app/api/admin/session",
    "src/app/admin/admin-sign-in.tsx",
    "src/server/storage/r2.ts",
    "src/server/storage/r2.test.ts",
    "src/server/explainer/video-state.redis.test.ts",
    "src/app/api/admin/reset",
    "src/server/generate/complimentary-gate.ts",
    "src/server/generate/rate-limit.ts",
    "src/server/storage/quota-store.ts",
    "src/server/explainer/audience.ts",
    "src/server/explainer/visitor.ts",
    "src/features/admin/priority-places.ts",
    "src/features/admin/limited-countries.ts",
    "src/server/http/vercel-geo.ts",
    "scripts/complimentary-quota-today.mjs",
    "vercel.json",
    "railway.json",
    "Dockerfile",
    "src/app/advertise",
    "src/app/out",
    "src/app/api/sponsor",
    "src/app/api/analytics-context",
    "src/app/api/admin/presence-feed",
    "src/app/api/admin/claude-credit",
    "src/components/live-presence.tsx",
    "src/components/sponsor-slot.tsx",
    "src/lib/analytics-client.ts",
    "workers/presence",
    "public/sponsors",
  ];

  for (const removed of removedPaths) {
    it(`no longer has ${removed}`, () => {
      expect(
        existsSync(path.join(root, removed)),
        `${removed} must be deleted`,
      ).toBe(false);
    });
  }
});

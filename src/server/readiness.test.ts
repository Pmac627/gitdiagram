// @vitest-environment node
//
// readiness.ts (Phase 5, step 21). The response shape stays
// { ok, checks: { ... booleans } }; the storage checks change:
//   configuration : DATA_DIR and CACHE_KEY_SECRET are set
//   provider      : unchanged (a provider API key is set; Phase 6 reworks it)
//   database      : the SQLite database opens and answers a query
//   dataDir       : DATA_DIR accepts a write (a probe file is created and removed)
// publicStorage, privateStorage and redis are gone. Runs against a real temp
// DATA_DIR. When configuration is incomplete nothing on disk is touched.
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkReadiness } from "~/server/readiness";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

const requiredEnvironment = {
  AI_PROVIDER: "openai",
  AI_API_KEY: "test-provider-key",
  AI_MODEL: "test-model",
  AI_BASE_URL: "https://llm.example.test/v1",
  CACHE_KEY_SECRET: "cache-secret",
};

let dataDir: TempDataDir;

beforeEach(async () => {
  dataDir = await createTempDataDir();
  Object.assign(process.env, requiredEnvironment);
});

afterEach(async () => {
  for (const name of Object.keys(requiredEnvironment)) {
    delete process.env[name];
  }
  await dataDir.dispose();
});

describe("checkReadiness", () => {
  it("reports the database and the data folder instead of R2 and Redis", async () => {
    const result = await checkReadiness();

    expect(result).toEqual({
      ok: true,
      checks: {
        configuration: true,
        provider: true,
        database: true,
        dataDir: true,
      },
    });
    expect(result.checks).not.toHaveProperty("redis");
    expect(result.checks).not.toHaveProperty("publicStorage");
    expect(result.checks).not.toHaveProperty("privateStorage");
  });

  it("needs no R2 or Upstash settings", async () => {
    for (const name of [
      "R2_PUBLIC_BUCKET",
      "R2_PRIVATE_BUCKET",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]) {
      delete process.env[name];
    }

    await expect(checkReadiness()).resolves.toMatchObject({ ok: true });
  });

  it("leaves nothing behind in DATA_DIR except the database files", async () => {
    await checkReadiness();
    await checkReadiness();

    const leftovers = readdirSync(dataDir.path).filter(
      (name) => !name.startsWith("gitdiagram.db"),
    );
    expect(leftovers).toEqual([]);
  });

  it("creates a missing DATA_DIR while checking", async () => {
    process.env.DATA_DIR = path.join(dataDir.path, "not", "yet", "there");

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: true,
      checks: { database: true, dataDir: true },
    });
  });

  it("fails without touching the disk when DATA_DIR is not configured", async () => {
    delete process.env.DATA_DIR;

    await expect(checkReadiness()).resolves.toEqual({
      ok: false,
      checks: {
        configuration: false,
        provider: true,
        database: false,
        dataDir: false,
      },
    });
    expect(readdirSync(dataDir.path)).toEqual([]);
  });

  it("fails without opening the database when CACHE_KEY_SECRET is missing", async () => {
    delete process.env.CACHE_KEY_SECRET;

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: false,
      checks: { configuration: false, database: false, dataDir: false },
    });
    expect(readdirSync(dataDir.path)).toEqual([]);
  });

  it("fails when the provider key is missing", async () => {
    delete process.env.AI_API_KEY;

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: false,
      checks: {
        configuration: true,
        provider: false,
        database: true,
        dataDir: true,
      },
    });
  });

  it.each([
    ["unknown provider", { AI_PROVIDER: "openrouter" }],
    ["missing non-OpenAI model", { AI_PROVIDER: "gemini", AI_MODEL: "" }],
    [
      "missing compatible provider base URL",
      { AI_PROVIDER: "openai-compatible", AI_BASE_URL: "" },
    ],
  ])("fails without touching disk for %s", async (_description, overrides) => {
    Object.assign(process.env, overrides);

    const result = await checkReadiness();

    expect(result.ok).toBe(false);
    expect(result.checks.provider).toBe(false);
    expect(result.checks.database).toBe(false);
    expect(result.checks.dataDir).toBe(false);
    expect(readdirSync(dataDir.path)).toEqual([]);
  });

  it("fails the storage checks, without throwing, when DATA_DIR is unusable", async () => {
    const brokenPath = path.join(dataDir.path, "not-a-directory");
    writeFileSync(brokenPath, "x");
    process.env.DATA_DIR = brokenPath;

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: false,
      checks: { configuration: true, database: false, dataDir: false },
    });
  });

  it("does not leak the data path in its result", async () => {
    const brokenPath = path.join(dataDir.path, "not-a-directory");
    writeFileSync(brokenPath, "x");
    process.env.DATA_DIR = brokenPath;

    const result = await checkReadiness();

    expect(JSON.stringify(result)).not.toContain(dataDir.path);
  });
});

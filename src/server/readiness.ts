import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  getBaseUrl,
  getModel,
  getProvider,
} from "~/server/generate/model-config";
import { readRequiredEnv } from "~/server/storage/config";
import { getDataDir, getDb } from "~/server/storage/db";

export interface ReadinessResult {
  ok: boolean;
  checks: {
    configuration: boolean;
    provider: boolean;
    database: boolean;
    dataDir: boolean;
  };
}

function hasProviderKey(): boolean {
  return Boolean(process.env.AI_API_KEY?.trim());
}

function hasValidProviderConfiguration(): boolean {
  try {
    const provider = getProvider();
    getModel(provider);
    getBaseUrl(provider);

    return true;
  } catch {
    return false;
  }
}

/** The SQLite database opens and answers a query. */
function checkDatabase(): boolean {
  try {
    return getDb().prepare("SELECT 1 AS ok").get()?.ok === 1;
  } catch {
    return false;
  }
}

/** DATA_DIR accepts a write: a probe file is created and removed. */
function checkDataDir(): boolean {
  let probe: string | null = null;

  try {
    const dir = getDataDir();
    mkdirSync(dir, { recursive: true });
    probe = path.join(dir, `.readiness-${randomUUID()}.tmp`);
    writeFileSync(probe, "ok");

    return true;
  } catch {
    return false;
  } finally {
    if (probe) {
      try {
        rmSync(probe, { force: true });
      } catch {
        // A probe that cannot be removed is not a readiness failure.
      }
    }
  }
}

/** Check configuration and local storage. @see docs/configuration.md */
export async function checkReadiness(): Promise<ReadinessResult> {
  let configuration = true;
  try {
    readRequiredEnv("DATA_DIR");
    readRequiredEnv("CACHE_KEY_SECRET");
  } catch {
    configuration = false;
  }

  const providerConfiguration = hasValidProviderConfiguration();

  // Invalid configuration must not open or write to local storage.
  const checks = {
    configuration,
    provider: providerConfiguration && hasProviderKey(),
    database: configuration && providerConfiguration && checkDatabase(),
    dataDir: configuration && providerConfiguration && checkDataDir(),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

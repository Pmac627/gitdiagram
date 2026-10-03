// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * VULN-001: the stored caller key is tied to the provider it was saved for.
 * Contract chosen for these tests:
 * - setCredential("openai_api_key", value, provider) requires a supported provider.
 * - CredentialStatus gains `configuredProvider` (server AI_PROVIDER) and
 *   `apiKeyProvider` (provider recorded on the cookie, or null).
 * - `openaiApiKeyConfigured` is true only when the recorded binding matches the
 *   server's configured provider (and base URL for openai-compatible).
 */

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    cookieStore: {
      get: vi.fn((name: string) => {
        const value = values.get(name);
        return value === undefined ? undefined : { name, value };
      }),
      set: vi.fn(
        (name: string, value: string, options?: { maxAge?: number }) => {
          if (options?.maxAge === 0) {
            values.delete(name);
          } else {
            values.set(name, value);
          }
        },
      ),
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

import {
  getCredentialStatus,
  resolveRequestCredentials,
  setCredential,
} from "~/server/http/request-credentials";

function sameOriginRequest(): Request {
  return new Request("https://gitdiagram.com/api/generate/stream", {
    headers: {
      Origin: "https://gitdiagram.com",
      "Sec-Fetch-Site": "same-origin",
    },
  });
}

async function resolvedKey(): Promise<string | undefined> {
  return (await resolveRequestCredentials(sameOriginRequest())).apiKey;
}

function allCookieValues(): string {
  return JSON.stringify([...mocks.values.entries()]);
}

describe("caller key provider binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.values.clear();
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("AI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies a key saved for the configured provider", async () => {
    await setCredential("openai_api_key", "sk-bound", "openai");

    await expect(resolvedKey()).resolves.toBe("sk-bound");
    await expect(getCredentialStatus()).resolves.toMatchObject({
      openaiApiKeyConfigured: true,
      apiKeyProvider: "openai",
      configuredProvider: "openai",
    });
  });

  it.each(["anthropic", "gemini", "grok", "openai-compatible"] as const)(
    "never applies an OpenAI key when the server is configured for %s",
    async (provider) => {
      await setCredential("openai_api_key", "sk-openai-only", "openai");
      vi.stubEnv("AI_PROVIDER", provider);
      vi.stubEnv("AI_BASE_URL", "https://llm.example.com/v1");

      await expect(resolvedKey()).resolves.toBeUndefined();
    },
  );

  it("ignores a key saved for another provider and reports the mismatch", async () => {
    await setCredential("openai_api_key", "sk-ant-secret", "anthropic");

    await expect(resolvedKey()).resolves.toBeUndefined();
    await expect(getCredentialStatus()).resolves.toMatchObject({
      openaiApiKeyConfigured: false,
      apiKeyProvider: "anthropic",
      configuredProvider: "openai",
    });
  });

  it("applies a key again when the server returns to the bound provider", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    await setCredential("openai_api_key", "gemini-key", "gemini");
    await expect(resolvedKey()).resolves.toBe("gemini-key");

    vi.stubEnv("AI_PROVIDER", "openai");
    await expect(resolvedKey()).resolves.toBeUndefined();

    vi.stubEnv("AI_PROVIDER", "gemini");
    await expect(resolvedKey()).resolves.toBe("gemini-key");
  });

  it("binds an openai-compatible key to the base URL it was saved for", async () => {
    vi.stubEnv("AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AI_BASE_URL", "http://localhost:11434/v1");
    await setCredential("openai_api_key", "local-key", "openai-compatible");
    await expect(resolvedKey()).resolves.toBe("local-key");

    vi.stubEnv("AI_BASE_URL", "http://localhost:8080/v1");
    await expect(resolvedKey()).resolves.toBeUndefined();
    await expect(getCredentialStatus()).resolves.toMatchObject({
      openaiApiKeyConfigured: false,
      apiKeyProvider: "openai-compatible",
    });

    vi.stubEnv("AI_BASE_URL", "https://api.other-host.example/v1");
    await expect(resolvedKey()).resolves.toBeUndefined();

    vi.stubEnv("AI_BASE_URL", "http://localhost:11434/v1");
    await expect(resolvedKey()).resolves.toBe("local-key");
  });

  it("rejects a missing or unsupported provider when saving a key", async () => {
    await expect(
      setCredential("openai_api_key", "sk-x", undefined as never),
    ).rejects.toThrow();
    await expect(
      setCredential("openai_api_key", "sk-x", "openrouter" as never),
    ).rejects.toThrow();
    await expect(
      setCredential("openai_api_key", "sk-x", "" as never),
    ).rejects.toThrow();

    expect(mocks.values.size).toBe(0);
    await expect(resolvedKey()).resolves.toBeUndefined();
  });

  /**
   * Decision: a legacy cookie (plain key, no provider tag) is IGNORED, for every
   * provider including openai. We cannot prove which endpoint it was meant for,
   * and create-provider.ts:23-26 already refuses it for non-OpenAI adapters; the
   * UI prompts the visitor to enter it again.
   */
  it.each(["openai", "anthropic", "openai-compatible"] as const)(
    "ignores a legacy untagged key cookie when the server uses %s",
    async (provider) => {
      vi.stubEnv("AI_PROVIDER", provider);
      vi.stubEnv("AI_BASE_URL", "https://llm.example.com/v1");
      mocks.values.set("gitdiagram_openai_api_key", "sk-legacy");

      await expect(resolvedKey()).resolves.toBeUndefined();
      await expect(getCredentialStatus()).resolves.toMatchObject({
        openaiApiKeyConfigured: false,
        apiKeyProvider: null,
      });
    },
  );

  it("never puts the key in the status", async () => {
    await setCredential("openai_api_key", "sk-never-echo", "openai");

    const status = await getCredentialStatus();

    expect(JSON.stringify(status)).not.toContain("sk-never-echo");
  });

  it("leaves the GitHub token unaffected by provider changes", async () => {
    await setCredential("github_pat", "github_pat_example");
    await setCredential("openai_api_key", "sk-x", "anthropic");

    await expect(
      resolveRequestCredentials(sameOriginRequest()),
    ).resolves.toMatchObject({
      apiKey: undefined,
      githubPat: "github_pat_example",
    });
    await expect(getCredentialStatus()).resolves.toMatchObject({
      githubPatConfigured: true,
    });
  });

  it("still prefers an explicit request key over stored credentials", async () => {
    await setCredential("openai_api_key", "sk-cookie", "anthropic");

    await expect(
      resolveRequestCredentials(sameOriginRequest(), { apiKey: "sk-explicit" }),
    ).resolves.toMatchObject({ apiKey: "sk-explicit" });
  });

  it("stores the key value in no cookie other than its own secret", async () => {
    await setCredential("openai_api_key", "sk-once", "openai");

    const occurrences = allCookieValues().split("sk-once").length - 1;
    expect(occurrences).toBe(1);
  });
});

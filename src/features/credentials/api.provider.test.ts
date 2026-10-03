import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCredentialStatus,
  migrateLegacyCredentialStorage,
  resetLegacyCredentialMigrationForTests,
  saveCredential,
} from "~/features/credentials/api";

const STATUS = {
  openaiApiKeyConfigured: true,
  githubPatConfigured: false,
  apiKeyProvider: "anthropic",
  configuredProvider: "anthropic",
};

afterEach(() => {
  resetLegacyCredentialMigrationForTests();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function bodies(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string) as unknown,
  );
}

describe("credential client API provider binding", () => {
  it("sends the provider with a saved API key", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, credentials: STATUS }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await saveCredential("openai_api_key", "sk-secret", "anthropic");

    expect(bodies(fetchMock)).toContainEqual({
      action: "set",
      credential: "openai_api_key",
      value: "sk-secret",
      provider: "anthropic",
    });
  });

  it("exposes the provider fields from the status response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, credentials: STATUS })),
    );

    await expect(getCredentialStatus()).resolves.toMatchObject({
      apiKeyProvider: "anthropic",
      configuredProvider: "anthropic",
    });
  });

  it("does not upload a legacy localStorage API key without a provider", async () => {
    window.localStorage.setItem("openai_api_key", "legacy-openai");
    window.localStorage.setItem("github_pat", "legacy-github");
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, credentials: STATUS }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await migrateLegacyCredentialStorage();

    expect(bodies(fetchMock)).not.toContainEqual(
      expect.objectContaining({ credential: "openai_api_key" }),
    );
    expect(bodies(fetchMock)).toContainEqual({
      action: "set",
      credential: "github_pat",
      value: "legacy-github",
    });
    expect(window.localStorage.getItem("openai_api_key")).toBeNull();
    expect(window.localStorage.getItem("github_pat")).toBeNull();
  });
});

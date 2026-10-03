// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as RequestCredentialsModule from "~/server/http/request-credentials";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  clearCredential: vi.fn(),
  getCredentialStatus: vi.fn(),
  setCredential: vi.fn(),
}));

vi.mock("~/server/http/request-credentials", async (importOriginal) => {
  const original = await importOriginal<typeof RequestCredentialsModule>();
  return {
    ...original,
    clearCredential: mocks.clearCredential,
    getCredentialStatus: mocks.getCredentialStatus,
    setCredential: mocks.setCredential,
  };
});

import { POST } from "~/app/api/credentials/route";
import { registerOperatorSession } from "~/server/auth/test-session";

const session = registerOperatorSession();

function request(body: unknown): Request {
  return new Request("https://gitdiagram.com/api/credentials", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Origin: "https://gitdiagram.com",
      ...session.headers,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/credentials provider binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const status = {
      openaiApiKeyConfigured: true,
      githubPatConfigured: false,
      apiKeyProvider: "openai",
      configuredProvider: "openai",
    };
    mocks.getCredentialStatus.mockResolvedValue(status);
    mocks.setCredential.mockResolvedValue(status);
    mocks.clearCredential.mockResolvedValue(status);
  });

  it("passes the provider to setCredential for an API key", async () => {
    const response = await POST(
      request({
        action: "set",
        credential: "openai_api_key",
        value: "sk-secret",
        provider: "anthropic",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.setCredential).toHaveBeenCalledWith(
      "openai_api_key",
      "sk-secret",
      "anthropic",
    );
    expect(JSON.stringify(await response.json())).not.toContain("sk-secret");
  });

  it.each(["openai", "anthropic", "gemini", "grok", "openai-compatible"])(
    "accepts the %s provider",
    async (provider) => {
      const response = await POST(
        request({
          action: "set",
          credential: "openai_api_key",
          value: "k",
          provider,
        }),
      );

      expect(response.status).toBe(200);
    },
  );

  it("rejects an API key saved without a provider", async () => {
    const response = await POST(
      request({ action: "set", credential: "openai_api_key", value: "sk-x" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.setCredential).not.toHaveBeenCalled();
  });

  it.each(["openrouter", "", "OPENAI ", 7, null])(
    "rejects the unsupported provider %j",
    async (provider) => {
      const response = await POST(
        request({
          action: "set",
          credential: "openai_api_key",
          value: "sk-x",
          provider,
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.setCredential).not.toHaveBeenCalled();
    },
  );

  it("still saves a GitHub token without a provider", async () => {
    const response = await POST(
      request({
        action: "set",
        credential: "github_pat",
        value: "github_pat_x",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.setCredential).toHaveBeenCalledWith(
      "github_pat",
      "github_pat_x",
      undefined,
    );
  });

  it("returns the provider state from status without any key value", async () => {
    mocks.getCredentialStatus.mockResolvedValue({
      openaiApiKeyConfigured: false,
      githubPatConfigured: false,
      apiKeyProvider: "anthropic",
      configuredProvider: "openai",
    });

    const response = await POST(request({ action: "status" }));

    await expect(response.json()).resolves.toEqual({
      ok: true,
      credentials: {
        openaiApiKeyConfigured: false,
        githubPatConfigured: false,
        apiKeyProvider: "anthropic",
        configuredProvider: "openai",
      },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  responses: vi.fn(() => ({ name: "responses" })),
  anthropic: vi.fn(() => ({ name: "anthropic" })),
  chat: vi.fn(() => ({ name: "chat" })),
}));

vi.mock("~/server/ai/openai-responses", () => ({
  createOpenAIResponsesProvider: adapters.responses,
}));
vi.mock("~/server/ai/anthropic", () => ({
  createAnthropicProvider: adapters.anthropic,
}));
vi.mock("~/server/ai/openai-chat", () => ({
  createOpenAIChatProvider: adapters.chat,
}));

import { createGenerationProvider } from "~/server/ai/create-provider";

const originalEnv = { ...process.env };

describe("createGenerationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_API_KEY = "server-secret";
    delete process.env.AI_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("selects OpenAI Responses with the operator-owned server key", () => {
    expect(createGenerationProvider({ provider: "openai" })).toEqual({
      name: "responses",
    });
    expect(adapters.responses).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "server-secret", managedKey: false }),
    );
    expect(adapters.anthropic).not.toHaveBeenCalled();
    expect(adapters.chat).not.toHaveBeenCalled();
  });

  it("selects OpenAI Responses with an explicit OpenAI key", () => {
    createGenerationProvider({ provider: "openai", apiKey: "caller-openai" });

    expect(adapters.responses).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "caller-openai", managedKey: false }),
    );
  });

  it("selects the Anthropic adapter with the server key", () => {
    expect(createGenerationProvider({ provider: "anthropic" })).toEqual({
      name: "anthropic",
    });
    expect(adapters.anthropic).toHaveBeenCalledWith({
      apiKey: "server-secret",
    });
    expect(adapters.responses).not.toHaveBeenCalled();
    expect(adapters.chat).not.toHaveBeenCalled();
  });

  it.each([
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/"],
    ["grok", "https://api.x.ai/v1"],
  ] as const)(
    "selects OpenAI Chat for %s with its preset URL",
    (provider, baseURL) => {
      expect(createGenerationProvider({ provider })).toEqual({ name: "chat" });
      expect(adapters.chat).toHaveBeenCalledWith({
        apiKey: "server-secret",
        baseURL,
      });
    },
  );

  it("selects OpenAI Chat for the configured compatible endpoint", () => {
    process.env.AI_BASE_URL = "http://127.0.0.1:1234/v1";

    createGenerationProvider({ provider: "openai-compatible" });

    expect(adapters.chat).toHaveBeenCalledWith({
      apiKey: "server-secret",
      baseURL: "http://127.0.0.1:1234/v1",
    });
  });

  it.each(["anthropic", "gemini", "grok", "openai-compatible"] as const)(
    "rejects an unbound caller key before constructing the %s adapter",
    (provider) => {
      process.env.AI_BASE_URL = "http://127.0.0.1:1234/v1";

      expect(() =>
        createGenerationProvider({ provider, apiKey: "legacy-openai-key" }),
      ).toThrow(/key|provider|credential/i);
      expect(adapters.responses).not.toHaveBeenCalled();
      expect(adapters.anthropic).not.toHaveBeenCalled();
      expect(adapters.chat).not.toHaveBeenCalled();
    },
  );

  it("rejects missing server credentials before constructing an adapter", () => {
    delete process.env.AI_API_KEY;

    expect(() => createGenerationProvider({ provider: "anthropic" })).toThrow(
      /AI_API_KEY/i,
    );
    expect(adapters.anthropic).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  getApiKey,
  getBaseUrl,
  getModel,
  getProvider,
  getGenerationServiceTier,
  shouldUseExactInputTokenCount,
  supportsTextVerbosity,
  usesSinglePassArchitecture,
} from "~/server/generate/model-config";

const ORIGINAL_ENV = { ...process.env };

describe("generation service tier", () => {
  it("uses standard billing for the operator-owned AI_API_KEY", () => {
    process.env.AI_API_KEY = "operator-owned-key";

    expect(
      getGenerationServiceTier({ provider: "openai", model: "gpt-6-luna" }),
    ).toBe("default");
    expect(
      usesSinglePassArchitecture({ provider: "openai", model: "gpt-6-luna" }),
    ).toBe(false);
  });

  it.each([
    "gpt-6-luna",
    "gpt-6-luna-2026-09-22",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra-2026-07-09",
  ])("uses standard billing for %s with the operator key", (model) => {
    expect(getGenerationServiceTier({ provider: "openai", model })).toBe(
      "default",
    );
  });
  it("preserves standard billing for user keys and unsupported providers/models", () => {
    for (const params of [
      {
        provider: "openai" as const,
        model: "gpt-5.6-luna",
        apiKey: "user-key",
      },
      { provider: "openai" as const, model: "gpt-5.4" },
      { provider: "gemini" as const, model: "gemini-2.5-flash" },
    ])
      expect(getGenerationServiceTier(params)).toBe("default");
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getProvider", () => {
  it.each(["openai", "anthropic", "gemini", "grok", "openai-compatible"])(
    "recognizes %s as a first-class provider",
    (provider) => {
      process.env.AI_PROVIDER = provider;

      expect(getProvider()).toBe(provider);
    },
  );

  it("rejects an unknown provider without silently selecting OpenAI", () => {
    process.env.AI_PROVIDER = "openrouter";

    expect(() => getProvider()).toThrow(/AI_PROVIDER/i);
    expect(() => getProvider("mystery-provider")).toThrow(/AI_PROVIDER/i);
  });
});

describe("getModel", () => {
  it("uses GPT-6 Luna as the OpenAI default", () => {
    delete process.env.OPENAI_MODEL;

    expect(getModel("openai")).toBe("gpt-6-luna");
  });

  it("uses the shared model setting for the selected provider", () => {
    process.env.AI_PROVIDER = "gemini";
    process.env.AI_MODEL = "gemini-custom-model";

    expect(getModel()).toBe("gemini-custom-model");
  });

  it("does not use the removed OpenRouter model setting", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.OPENROUTER_MODEL = "openai/legacy-model";
    delete process.env.AI_MODEL;

    expect(getModel()).toBe("gpt-6-luna");
  });

  it("requires an explicit model for each non-OpenAI provider", () => {
    delete process.env.AI_MODEL;

    for (const provider of [
      "anthropic",
      "gemini",
      "grok",
      "openai-compatible",
    ] as const) {
      expect(() => getModel(provider)).toThrow(/AI_MODEL/i);
    }
  });
});

describe("provider connection configuration", () => {
  it.each([
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/"],
    ["grok", "https://api.x.ai/v1"],
  ] as const)("uses the %s OpenAI-compatible preset", (provider, baseUrl) => {
    expect(getBaseUrl(provider)).toBe(baseUrl);
  });

  it("uses a trimmed AI_BASE_URL override for the compatible provider", () => {
    process.env.AI_BASE_URL = " https://llm.example.test/v1 ";

    expect(getBaseUrl("openai-compatible")).toBe("https://llm.example.test/v1");
  });

  it("allows a local HTTP endpoint and overrides a preset", () => {
    process.env.AI_BASE_URL = "http://127.0.0.1:1234/v1";

    expect(getBaseUrl("openai-compatible")).toBe("http://127.0.0.1:1234/v1");
    expect(getBaseUrl("gemini")).toBe("http://127.0.0.1:1234/v1");
  });

  it("requires an explicit endpoint for the compatible provider", () => {
    delete process.env.AI_BASE_URL;

    expect(() => getBaseUrl("openai-compatible")).toThrow(/AI_BASE_URL/i);
    expect(getBaseUrl("openai")).toBeUndefined();
    expect(getBaseUrl("anthropic")).toBeUndefined();
  });

  it.each([
    "not a URL",
    "https://user:password@llm.example.test/v1",
    "https://llm.example.test/v1?key=secret-value",
    "https://llm.example.test/v1#fragment",
    "http://llm.example.test/v1",
    "https://llm.example.test\\unexpected/v1",
  ])("rejects unsafe custom base URL input without echoing it", (baseUrl) => {
    process.env.AI_BASE_URL = baseUrl;

    let message = "";
    try {
      getBaseUrl("openai-compatible");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/AI_BASE_URL/i);
    expect(message).not.toContain(baseUrl);
    expect(message).not.toContain("password");
    expect(message).not.toContain("secret-value");
  });

  it("reads the shared API key without exposing it in configuration errors", () => {
    process.env.AI_API_KEY = " secret-key-value ";

    expect(getApiKey()).toBe("secret-key-value");
    delete process.env.AI_API_KEY;

    let message = "";
    try {
      getApiKey();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/AI_API_KEY/i);
    expect(message).not.toContain("secret-key-value");
  });
});

describe("shouldUseExactInputTokenCount", () => {
  it.each(["anthropic", "gemini", "grok", "openai-compatible"] as const)(
    "keeps %s on the conservative local token fallback",
    (provider) => {
      expect(
        shouldUseExactInputTokenCount({
          provider,
          apiKey: "apikey-test",
        }),
      ).toBe(false);
    },
  );
});

describe("supportsTextVerbosity", () => {
  it.each([
    "gpt-6-luna",
    "gpt-6-luna-2026-09-22",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-terra-2026-07-09",
    " GPT-5.6-LUNA-2026-07-09 ",
  ])("accepts the supported OpenAI model %s", (model) => {
    expect(supportsTextVerbosity("openai", model)).toBe(true);
  });

  it.each([
    ["openai", "gpt-6-luna-preview"],
    ["openai", "gpt-6-unknown"],
    ["openai", "gpt-5.4"],
    ["openai", "gpt-5.6-pro"],
    ["openai", "gpt-5.6-terra-preview"],
    ["gemini", "gemini-2.5-flash"],
  ] as const)(
    "rejects unsupported provider/model pair %s/%s",
    (provider, model) => {
      expect(supportsTextVerbosity(provider, model)).toBe(false);
    },
  );
});

describe("single-pass Luna architecture", () => {
  it.each(["gpt-6-luna", "gpt-6-luna-2026-09-22", "gpt-5.6-luna"])(
    "preserves one-pass generation and user-key billing for %s",
    (model) => {
      expect(usesSinglePassArchitecture({ provider: "openai", model })).toBe(
        true,
      );
      const userKey = {
        provider: "openai" as const,
        model,
        apiKey: "user-key",
      };
      expect(usesSinglePassArchitecture(userKey)).toBe(false);
      expect(getGenerationServiceTier(userKey)).toBe("default");
      expect(usesSinglePassArchitecture({ provider: "gemini", model })).toBe(
        false,
      );
    },
  );
});

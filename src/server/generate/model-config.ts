/** Select a diagram generation provider. @see docs/configuration.md */
export const AI_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "openai-compatible",
] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];
export type GenerationServiceTier = "default" | "priority";

const DEFAULT_PROVIDER: AIProvider = "openai";
const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
const PROVIDERS: ReadonlySet<string> = new Set(AI_PROVIDERS);
const PROVIDER_BASE_URLS: Partial<Record<AIProvider, string>> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  grok: "https://api.x.ai/v1",
};
const MANAGED_OPENAI_MODEL_PATTERN =
  /^gpt-(?:5\.6(?:-(?:sol|terra|luna))?|6-luna)(?:-\d{4}-\d{2}-\d{2})?$/i;

function readEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function normalizeProvider(value?: string): AIProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_PROVIDER;
  }

  if (!PROVIDERS.has(normalized)) {
    throw new Error("Invalid AI_PROVIDER configuration.");
  }

  return normalized as AIProvider;
}

/** Read and validate the selected provider. @see docs/configuration.md */
export function getProvider(overrideProvider?: string): AIProvider {
  return normalizeProvider(overrideProvider ?? readEnvValue("AI_PROVIDER"));
}

/** Get the name to show for a provider. @see docs/configuration.md */
export function getProviderLabel(provider: AIProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case "grok":
      return "Grok";
    case "openai-compatible":
      return "OpenAI-compatible";
    default:
      throw new Error("Invalid AI_PROVIDER configuration.");
  }
}

export function supportsExactInputTokenCount(provider: AIProvider): boolean {
  return provider === "openai";
}

export function supportsTextVerbosity(
  provider: AIProvider,
  model: string,
): boolean {
  return (
    provider === "openai" && MANAGED_OPENAI_MODEL_PATTERN.test(model.trim())
  );
}

/** Use standard billing for operator and caller keys. @see docs/flows/diagram-generation.md */
export function getGenerationServiceTier(_params: {
  provider: AIProvider;
  model: string;
  apiKey?: string;
}): GenerationServiceTier {
  return "default";
}

/**
 * Use the legacy single-pass plan only when no operator key is configured.
 * @see docs/flows/diagram-generation.md
 */
export function usesSinglePassArchitecture(params: {
  provider: AIProvider;
  model: string;
  apiKey?: string;
}): boolean {
  return (
    params.provider === "openai" &&
    !params.apiKey?.trim() &&
    !process.env.AI_API_KEY?.trim() &&
    /^gpt-(?:5\.6|6)-luna(?:-\d{4}-\d{2}-\d{2})?$/i.test(params.model.trim())
  );
}

export function shouldUseExactInputTokenCount(params: {
  provider: AIProvider;
  apiKey?: string;
}): boolean {
  return (
    supportsExactInputTokenCount(params.provider) &&
    Boolean(params.apiKey?.trim())
  );
}

/** Read the model for the selected provider. @see docs/configuration.md */
export function getModel(provider = getProvider()): string {
  const model = readEnvValue("AI_MODEL");
  if (model) {
    return model;
  }

  if (provider === "openai") {
    return DEFAULT_OPENAI_MODEL;
  }

  throw new Error("Missing AI_MODEL configuration.");
}

/** Read the server API key. @see docs/configuration.md */
export function getApiKey(): string {
  const apiKey = readEnvValue("AI_API_KEY");
  if (!apiKey) {
    throw new Error("Missing AI_API_KEY configuration.");
  }

  return apiKey;
}

/** Read and validate the provider endpoint. @see docs/configuration.md */
export function getBaseUrl(provider = getProvider()): string | undefined {
  const configured = readEnvValue("AI_BASE_URL");
  if (configured) {
    let url: URL;

    try {
      url = new URL(configured);
    } catch {
      throw new Error("Invalid AI_BASE_URL configuration.");
    }

    const isLocalHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLocalHost)) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[\s\\]/u.test(configured) ||
      configured.includes("?") ||
      configured.includes("#")
    ) {
      throw new Error("Invalid AI_BASE_URL configuration.");
    }

    return configured;
  }

  if (provider === "openai-compatible") {
    throw new Error("Missing AI_BASE_URL configuration.");
  }

  return PROVIDER_BASE_URLS[provider];
}

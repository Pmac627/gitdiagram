import { createAnthropicProvider } from "./anthropic";
import { createOpenAIChatProvider } from "./openai-chat";
import { createOpenAIResponsesProvider } from "./openai-responses";
import type { GenerationProvider } from "./provider";
import {
  getApiKey,
  getBaseUrl,
  type AIProvider,
} from "~/server/generate/model-config";

/**
 * Create the adapter for the configured provider and its bound credentials.
 * @see docs/flows/diagram-generation.md
 */
export function createGenerationProvider(options: {
  provider: AIProvider;
  apiKey?: string;
}): GenerationProvider {
  if (!options.provider) {
    throw new Error("A generation provider is required.");
  }

  const callerKey = options.apiKey?.trim();
  if (callerKey && options.provider !== "openai") {
    throw new Error("Caller API key is not bound to the selected provider.");
  }

  const apiKey = callerKey || getApiKey();

  switch (options.provider) {
    case "openai":
      return createOpenAIResponsesProvider({ apiKey, managedKey: false });
    case "anthropic":
      return createAnthropicProvider({ apiKey });
    case "gemini":
    case "grok":
    case "openai-compatible":
      return createOpenAIChatProvider({
        apiKey,
        baseURL: getBaseUrl(options.provider),
      });
    default:
      throw new Error("Invalid AI_PROVIDER configuration.");
  }
}

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { GenerationTokenUsage } from "~/features/diagram/cost";
import {
  rethrowAsUpstreamProviderError,
  UpstreamProviderError,
} from "~/server/generate/errors";
import {
  getGenerationServiceTier,
  supportsTextVerbosity,
} from "~/server/generate/model-config";
import { normalizeGenerationUsage } from "~/server/generate/pricing";
import type {
  GenerationProvider,
  StructuredRequest,
  TextRequest,
  TokenCountRequest,
} from "./provider";

const AI_REQUEST_TIMEOUT_MS = 150_000;
const AI_MAX_RETRIES = 0;

function buildRequestOptions(params: {
  signal?: AbortSignal;
  clientRequestId?: string;
}) {
  const headers = params.clientRequestId
    ? { "X-Client-Request-Id": params.clientRequestId }
    : undefined;

  if (!params.signal && !headers) {
    return undefined;
  }

  return {
    ...(params.signal ? { signal: params.signal } : {}),
    ...(headers ? { headers } : {}),
  };
}

function buildMessages(systemPrompt: string, userPrompt: string) {
  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];
}

const NO_PARSED_STRUCTURED_PAYLOAD_ERROR =
  "Structured output parsing returned no parsed payload.";

function getResponseFailureMessage(response: {
  error?: { message?: string | null } | null;
  incomplete_details?: { reason?: string | null } | null;
}): string {
  if (response.error?.message) {
    return response.error.message;
  }

  if (response.incomplete_details?.reason) {
    return `OpenAI response incomplete: ${response.incomplete_details.reason}.`;
  }

  return "OpenAI response did not complete successfully.";
}

async function retrieveUsageFromResponseId(
  client: OpenAI,
  responseId: string | undefined,
  signal?: AbortSignal,
  clientRequestId?: string,
): Promise<GenerationTokenUsage | null> {
  if (!responseId) {
    return null;
  }

  const response = await client.responses.retrieve(
    responseId,
    undefined,
    buildRequestOptions({ signal, clientRequestId }),
  );
  return normalizeGenerationUsage(response.usage, response.service_tier);
}

async function streamCompletion(
  client: OpenAI,
  managedKey: boolean,
  {
    model,
    systemPrompt,
    userPrompt,
    reasoningEffort,
    textVerbosity,
    outputSchema,
    signal,
    clientRequestId,
  }: TextRequest,
): ReturnType<GenerationProvider["streamText"]> {
  const stream = await client.responses
    .create(
      {
        model,
        service_tier: getGenerationServiceTier({
          provider: "openai",
          model,
          apiKey: managedKey ? undefined : "caller-key",
        }),
        stream: true,
        input: buildMessages(systemPrompt, userPrompt),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        ...(outputSchema ||
        (textVerbosity && supportsTextVerbosity("openai", model))
          ? {
              text: {
                ...(outputSchema
                  ? {
                      format: zodTextFormat(
                        outputSchema,
                        "repository_architecture",
                      ),
                    }
                  : {}),
                ...(textVerbosity && supportsTextVerbosity("openai", model)
                  ? { verbosity: textVerbosity }
                  : {}),
              },
            }
          : {}),
      },
      buildRequestOptions({ signal, clientRequestId }),
    )
    .catch(rethrowAsUpstreamProviderError);

  let usageSettled = false;
  let resolveUsage!: (usage: GenerationTokenUsage | null) => void;
  const usagePromise = new Promise<GenerationTokenUsage | null>((resolve) => {
    resolveUsage = resolve;
  });

  async function* outputStream(): AsyncGenerator<string, void, void> {
    let responseId: string | undefined;
    let finalUsage: GenerationTokenUsage | null = null;
    let completed = false;

    try {
      for await (const event of stream) {
        const response = "response" in event ? event.response : undefined;
        if (response?.id) {
          responseId = response.id;
        }

        if (event.type === "response.output_text.delta") {
          if (event.delta) {
            yield event.delta;
          }
          continue;
        }

        if (event.type === "response.completed") {
          completed = true;
          finalUsage = normalizeGenerationUsage(
            event.response.usage,
            event.response.service_tier,
          );
          continue;
        }

        if (event.type === "response.failed") {
          throw new Error(getResponseFailureMessage(event.response));
        }

        if (event.type === "response.incomplete") {
          throw new Error(getResponseFailureMessage(event.response));
        }

        if (event.type === "error") {
          const message = event.message ?? "OpenAI stream failed.";
          throw new Error(message);
        }
      }

      if (!completed) {
        throw new Error("OpenAI stream ended before response.completed.");
      }

      if (!finalUsage) {
        try {
          finalUsage = await retrieveUsageFromResponseId(
            client,
            responseId,
            signal,
            clientRequestId ? `${clientRequestId}:usage` : undefined,
          );
        } catch {
          finalUsage = null;
        }
      }

      usageSettled = true;
      resolveUsage(finalUsage);
    } catch (error) {
      resolveUsage(null);
      usageSettled = true;
      rethrowAsUpstreamProviderError(error);
    } finally {
      // Covers the generator being returned early (a consumer that stops
      // iterating), which resolves neither branch above.
      if (!usageSettled) {
        resolveUsage(null);
      }
    }
  }

  return {
    stream: outputStream(),
    usagePromise,
  };
}

async function countInputTokens(
  client: OpenAI,
  {
    model,
    systemPrompt,
    userPrompt,
    reasoningEffort,
    signal,
    clientRequestId,
  }: TokenCountRequest,
): Promise<number> {
  const response = await client.responses.inputTokens
    .count(
      {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      },
      buildRequestOptions({ signal, clientRequestId }),
    )
    .catch(rethrowAsUpstreamProviderError);

  return response.input_tokens;
}

async function generateStructuredOutput<T>(
  client: OpenAI,
  managedKey: boolean,
  {
    model,
    systemPrompt,
    userPrompt,
    schema,
    schemaName,
    reasoningEffort,
    textVerbosity,
    signal,
    clientRequestId,
  }: StructuredRequest<T>,
): Promise<{
  output: T;
  rawText: string;
  usage: GenerationTokenUsage | null;
}> {
  try {
    const response = await client.responses.parse(
      {
        model,
        service_tier: getGenerationServiceTier({
          provider: "openai",
          model,
          apiKey: managedKey ? undefined : "caller-key",
        }),
        input: buildMessages(systemPrompt, userPrompt),
        text: {
          format: zodTextFormat(schema, schemaName),
          ...(textVerbosity && supportsTextVerbosity("openai", model)
            ? { verbosity: textVerbosity }
            : {}),
        },
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      },
      buildRequestOptions({ signal, clientRequestId }),
    );

    if (response.output_parsed == null) {
      throw new UpstreamProviderError(NO_PARSED_STRUCTURED_PAYLOAD_ERROR);
    }

    const parsed = schema.safeParse(response.output_parsed);
    if (!parsed.success) {
      throw new UpstreamProviderError(
        "Model returned invalid structured output.",
      );
    }

    const rawText =
      response.output_text?.trim() ||
      JSON.stringify(response.output_parsed, null, 2);

    return {
      output: parsed.data,
      rawText,
      usage: normalizeGenerationUsage(response.usage, response.service_tier),
    };
  } catch (error) {
    rethrowAsUpstreamProviderError(error);
  }
}

/**
 * Create a Responses provider for one API key.
 * @see docs/flows/diagram-generation.md
 */
export function createOpenAIResponsesProvider(options: {
  apiKey: string;
  client?: OpenAI;
  managedKey?: boolean;
}): GenerationProvider {
  if (!options.apiKey?.trim()) {
    throw new Error("OpenAI API key is required.");
  }

  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      maxRetries: AI_MAX_RETRIES,
      timeout: AI_REQUEST_TIMEOUT_MS,
    });
  const managedKey = options.managedKey ?? false;

  return {
    streamText: (request) => streamCompletion(client, managedKey, request),
    parseStructured: (request) =>
      generateStructuredOutput(client, managedKey, request),
    countInputTokens: (request) => countInputTokens(client, request),
  };
}

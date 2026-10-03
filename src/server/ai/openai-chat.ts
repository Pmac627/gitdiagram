import OpenAI from "openai";
import { z } from "zod";

import type { GenerationTokenUsage } from "~/features/diagram/cost";
import {
  rethrowAsUpstreamProviderError,
  UpstreamProviderError,
} from "~/server/generate/errors";
import type {
  GenerationProvider,
  StructuredRequest,
  TextRequest,
} from "./provider";

const REQUEST_TIMEOUT_MS = 150_000;
const FALLBACK_ATTEMPTS = 2;
const SCHEMA_REJECTION_STATUSES = new Set([400, 404, 422]);
// Gemini's OpenAI-compatible endpoint refuses parts of a strict schema with a
// bare "invalid argument" that names no field.
const SCHEMA_REJECTION_PATTERN =
  /structured outputs?|response_format|json_schema|invalid.argument/i;

const MAX_FEEDBACK_ISSUES = 5;
const MAX_ISSUE_MESSAGE_LENGTH = 120;
const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * The JSON inside a model answer. Without schema mode, models often wrap it in
 * a Markdown fence or add a sentence before it.
 */
function jsonText(text: string): string {
  const fenced = FENCED_JSON_PATTERN.exec(text)?.[1];
  if (fenced !== undefined) {
    return fenced.trim();
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function requestOptions(request: {
  signal?: AbortSignal;
  clientRequestId?: string;
}) {
  const headers = request.clientRequestId
    ? { "X-Client-Request-Id": request.clientRequestId }
    : undefined;
  return request.signal || headers
    ? {
        ...(request.signal ? { signal: request.signal } : {}),
        ...(headers ? { headers } : {}),
      }
    : undefined;
}

function messages(request: TextRequest) {
  return [
    { role: "system" as const, content: request.systemPrompt },
    { role: "user" as const, content: request.userPrompt },
  ];
}

function usageOf(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | null
    | undefined,
): GenerationTokenUsage | null {
  if (!usage) {
    return null;
  }

  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

function isSchemaRejection(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = (error as Error & { status?: unknown }).status;
  return (
    typeof status === "number" &&
    SCHEMA_REJECTION_STATUSES.has(status) &&
    SCHEMA_REJECTION_PATTERN.test(error.message)
  );
}

async function streamText(client: OpenAI, request: TextRequest) {
  let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    stream = await client.chat.completions.create(
      {
        model: request.model,
        messages: messages(request),
        stream: true,
      },
      requestOptions(request),
    );
  } catch (error) {
    rethrowAsUpstreamProviderError(error);
  }

  let resolveUsage!: (usage: GenerationTokenUsage | null) => void;
  const usagePromise = new Promise<GenerationTokenUsage | null>((resolve) => {
    resolveUsage = resolve;
  });

  async function* outputStream(): AsyncGenerator<string, void, void> {
    let finalUsage: GenerationTokenUsage | null = null;
    let failed = false;

    try {
      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
        finalUsage = usageOf(chunk.usage) ?? finalUsage;
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } catch (error) {
      failed = true;
      rethrowAsUpstreamProviderError(error);
    } finally {
      resolveUsage(failed ? null : finalUsage);
    }
  }

  return { stream: outputStream(), usagePromise };
}

async function parseStructured<T>(
  client: OpenAI,
  request: StructuredRequest<T>,
): Promise<{ output: T; rawText: string; usage: GenerationTokenUsage | null }> {
  const schema = z.toJSONSchema(request.schema) as Record<string, unknown>;
  // Without schema mode the model sees the schema only here, so it gets the
  // whole of it: nested fields, allowed values and limits.
  const promptSchema = { ...schema };
  delete promptSchema.$schema;
  const schemaGuidance = `Return only a JSON value, with no Markdown, that matches this JSON Schema: ${JSON.stringify(promptSchema)}`;
  let fallback = false;
  let validationFeedback = "Return valid JSON matching the requested schema.";

  for (let attempt = 0; attempt <= FALLBACK_ATTEMPTS; attempt++) {
    request.signal?.throwIfAborted();
    const prompt = fallback
      ? `${request.userPrompt}\n\n${schemaGuidance} ${validationFeedback}`
      : request.userPrompt;
    let response: OpenAI.Chat.Completions.ChatCompletion;

    try {
      response = await client.chat.completions.create(
        {
          model: request.model,
          messages: messages({ ...request, userPrompt: prompt }),
          stream: false,
          ...(fallback
            ? {}
            : {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: request.schemaName,
                    strict: true,
                    schema,
                  },
                },
              }),
        },
        requestOptions(request),
      );
    } catch (error) {
      if (!fallback && isSchemaRejection(error)) {
        fallback = true;
        continue;
      }

      rethrowAsUpstreamProviderError(error);
    }

    const rawText = response.choices[0]?.message?.content;
    try {
      if (!rawText) {
        throw new Error("Missing content.");
      }

      const parsed = request.schema.safeParse(JSON.parse(jsonText(rawText)));
      if (!parsed.success) {
        const problems = parsed.error.issues
          .slice(0, MAX_FEEDBACK_ISSUES)
          .map((issue) => {
            const where = issue.path.map(String).join(".") || "(root)";
            return `${where}: ${issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)}`;
          });
        validationFeedback = `Fix these problems: ${problems.join("; ")}.`;
        throw new Error("Schema validation failed.");
      }

      return {
        output: parsed.data,
        rawText,
        usage: usageOf(response.usage),
      };
    } catch {
      if (!fallback || attempt === FALLBACK_ATTEMPTS) {
        throw new UpstreamProviderError(
          "Model returned invalid structured output.",
        );
      }
    }
  }

  throw new UpstreamProviderError("Model did not support structured output.");
}

/**
 * Create a Chat provider for a compatible API.
 * @see docs/flows/diagram-generation.md
 */
export function createOpenAIChatProvider(options: {
  apiKey: string;
  baseURL?: string;
  client?: OpenAI;
}): GenerationProvider {
  if (!options.apiKey?.trim()) {
    throw new Error("OpenAI-compatible API key is required.");
  }

  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });

  return {
    streamText: (request) => streamText(client, request),
    parseStructured: (request) => parseStructured(client, request),
  };
}

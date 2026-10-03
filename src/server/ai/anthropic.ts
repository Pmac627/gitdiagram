import Anthropic from "@anthropic-ai/sdk";
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
const MAX_OUTPUT_TOKENS = 8192;

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

function usageOf(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): GenerationTokenUsage | null {
  if (inputTokens === undefined && outputTokens === undefined) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

async function streamText(client: Anthropic, request: TextRequest) {
  let events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>;
  try {
    events = await client.messages.create(
      {
        model: request.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
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
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let failed = false;

    try {
      for await (const event of events) {
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
        } else if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens;
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          if (event.delta.text) {
            yield event.delta.text;
          }
        }
      }
    } catch (error) {
      failed = true;
      rethrowAsUpstreamProviderError(error);
    } finally {
      resolveUsage(failed ? null : usageOf(inputTokens, outputTokens));
    }
  }

  return { stream: outputStream(), usagePromise };
}

async function parseStructured<T>(
  client: Anthropic,
  request: StructuredRequest<T>,
): Promise<{ output: T; rawText: string; usage: GenerationTokenUsage | null }> {
  const schema = z.toJSONSchema(
    request.schema,
  ) as Anthropic.Messages.Tool.InputSchema;
  try {
    const response = await client.messages.create(
      {
        model: request.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        stream: false,
        tools: [{ name: request.schemaName, input_schema: schema }],
        tool_choice: { type: "tool", name: request.schemaName },
      },
      requestOptions(request),
    );

    const tools = response.content.filter((block) => block.type === "tool_use");
    const tool = tools[0];
    if (
      response.stop_reason !== "tool_use" ||
      tools.length !== 1 ||
      !tool ||
      tool.type !== "tool_use" ||
      tool.name !== request.schemaName
    ) {
      throw new UpstreamProviderError(
        "Model did not return the required tool output.",
      );
    }

    const parsed = request.schema.safeParse(tool.input);
    if (!parsed.success) {
      throw new UpstreamProviderError(
        "Model returned invalid structured output.",
      );
    }

    return {
      output: parsed.data,
      rawText: JSON.stringify(tool.input),
      usage: usageOf(response.usage.input_tokens, response.usage.output_tokens),
    };
  } catch (error) {
    rethrowAsUpstreamProviderError(error);
  }
}

/**
 * Create an Anthropic provider for one API key.
 * @see docs/flows/diagram-generation.md
 */
export function createAnthropicProvider(options: {
  apiKey: string;
  client?: Anthropic;
}): GenerationProvider {
  if (!options.apiKey?.trim()) {
    throw new Error("Anthropic API key is required.");
  }

  const client =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });

  return {
    streamText: (request) => streamText(client, request),
    parseStructured: (request) => parseStructured(client, request),
  };
}

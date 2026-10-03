import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { UpstreamProviderError } from "~/server/generate/errors";
import { createOpenAIResponsesProvider } from "./openai-responses";
import type { GenerationProvider } from "./provider";

async function* events(values: unknown[]) {
  for (const value of values) {
    yield value;
  }
}

async function collect(stream: AsyncGenerator<string, void, void>) {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function fakeClient() {
  const create = vi.fn();
  const parse = vi.fn();
  const retrieve = vi.fn();
  const count = vi.fn();
  return {
    responses: { create, parse, retrieve, inputTokens: { count } },
  };
}

describe("OpenAI Responses provider", () => {
  it("streams text, reports usage, and preserves request options", async () => {
    const client = fakeClient();
    client.responses.create.mockResolvedValue(
      events([
        { type: "response.output_text.delta", delta: "first" },
        { type: "response.output_text.delta", delta: " second" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            service_tier: "priority",
            usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          },
        },
      ]),
    );
    const provider: GenerationProvider = createOpenAIResponsesProvider({
      apiKey: "sk-test",
      client: client as never,
    });
    const signal = new AbortController().signal;

    const result = await provider.streamText({
      model: "gpt-6-luna",
      systemPrompt: "system",
      userPrompt: "user",
      reasoningEffort: "medium",
      textVerbosity: "low",
      signal,
      clientRequestId: "session:explanation",
    });

    await expect(collect(result.stream)).resolves.toEqual(["first", " second"]);
    await expect(result.usagePromise).resolves.toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      serviceTier: "priority",
    });
    expect(client.responses.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-luna",
        stream: true,
        input: [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
        reasoning: { effort: "medium" },
        text: { verbosity: "low" },
      }),
      {
        signal,
        headers: { "X-Client-Request-Id": "session:explanation" },
      },
    );
  });

  it("parses a Zod payload and retains raw text and measured usage", async () => {
    const client = fakeClient();
    client.responses.parse.mockResolvedValue({
      output_parsed: { value: "ok" },
      output_text: '{"value":"ok"}',
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    });
    const provider = createOpenAIResponsesProvider({
      apiKey: "sk-test",
      client: client as never,
    });

    await expect(
      provider.parseStructured({
        model: "gpt-6-luna",
        systemPrompt: "system",
        userPrompt: "user",
        schema: z.object({ value: z.string() }),
        schemaName: "diagram_graph",
      }),
    ).resolves.toMatchObject({
      output: { value: "ok" },
      rawText: '{"value":"ok"}',
      usage: { totalTokens: 12 },
    });
    expect(client.responses.parse.mock.calls[0]?.[0]).toMatchObject({
      text: { format: { type: "json_schema" } },
    });
  });

  it("counts input tokens when the Responses endpoint supports it", async () => {
    const client = fakeClient();
    client.responses.inputTokens.count.mockResolvedValue({ input_tokens: 42 });
    const provider = createOpenAIResponsesProvider({
      apiKey: "sk-test",
      client: client as never,
    });

    await expect(
      provider.countInputTokens?.({
        model: "gpt-6-luna",
        systemPrompt: "system",
        userPrompt: "user",
      }),
    ).resolves.toBe(42);
  });

  it("rejects an SDK payload that fails the requested schema without exposing its values", async () => {
    const client = fakeClient();
    client.responses.parse.mockResolvedValue({
      output_parsed: { value: 123, secret: "sk-private-value" },
      output_text: '{"value":123,"secret":"sk-private-value"}',
    });
    const provider = createOpenAIResponsesProvider({
      apiKey: "sk-test",
      client: client as never,
    });

    const failure = await provider
      .parseStructured({
        model: "gpt-6-luna",
        systemPrompt: "system",
        userPrompt: "user",
        schema: z.object({ value: z.string() }),
        schemaName: "payload",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamProviderError);
    expect((failure as Error).message).not.toContain("sk-private-value");
  });

  it("propagates cancellation unchanged and settles stream usage", async () => {
    const client = fakeClient();
    const abort = new DOMException("Cancelled", "AbortError");
    client.responses.create.mockResolvedValue(
      events([
        { type: "response.output_text.delta", delta: "partial" },
        { type: "response.failed", response: { error: { message: "failed" } } },
      ]),
    );
    const provider = createOpenAIResponsesProvider({
      apiKey: "sk-test",
      client: client as never,
    });
    const result = await provider.streamText({
      model: "gpt-6-luna",
      systemPrompt: "system",
      userPrompt: "user",
    });
    await expect(collect(result.stream)).rejects.toBeInstanceOf(
      UpstreamProviderError,
    );
    await expect(result.usagePromise).resolves.toBeNull();

    client.responses.parse.mockRejectedValue(abort);
    await expect(
      provider.parseStructured({
        model: "gpt-6-luna",
        systemPrompt: "system",
        userPrompt: "user",
        schema: z.object({ value: z.string() }),
        schemaName: "payload",
      }),
    ).rejects.toBe(abort);
  });
});

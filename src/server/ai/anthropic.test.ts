import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { UpstreamProviderError } from "~/server/generate/errors";
import { createAnthropicProvider } from "./anthropic";
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
  return { messages: { create: vi.fn() } };
}

describe("Anthropic provider", () => {
  it("streams only visible text and maps final token usage", async () => {
    const client = fakeClient();
    client.messages.create.mockResolvedValue(
      events([
        {
          type: "message_start",
          message: { usage: { input_tokens: 11, output_tokens: 0 } },
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" },
        },
        { type: "message_delta", usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ]),
    );
    const provider: GenerationProvider = createAnthropicProvider({
      apiKey: "sk-ant-test",
      client: client as never,
    });
    const signal = new AbortController().signal;
    const result = await provider.streamText({
      model: "claude-sonnet-4-5",
      systemPrompt: "system",
      userPrompt: "user",
      signal,
    });

    await expect(collect(result.stream)).resolves.toEqual(["hello", " world"]);
    await expect(result.usagePromise).resolves.toMatchObject({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
    });
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-5",
        system: "system",
        messages: [{ role: "user", content: "user" }],
        stream: true,
      }),
      expect.objectContaining({ signal }),
    );
  });

  it("forces one named tool and validates its input with Zod", async () => {
    const client = fakeClient();
    client.messages.create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "I will now make the graph." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "diagram_graph",
          input: { value: "ok" },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 7 },
    });
    const provider = createAnthropicProvider({
      apiKey: "sk-ant-test",
      client: client as never,
    });
    const signal = new AbortController().signal;

    await expect(
      provider.parseStructured({
        model: "claude-sonnet-4-5",
        systemPrompt: "system",
        userPrompt: "user",
        schema: z.object({ value: z.string() }),
        schemaName: "diagram_graph",
        signal,
      }),
    ).resolves.toMatchObject({
      output: { value: "ok" },
      usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
    });

    const [body, requestOptions] = client.messages.create.mock.calls[0] ?? [];
    expect(body).toMatchObject({
      stream: false,
      tool_choice: { type: "tool", name: "diagram_graph" },
      tools: [
        {
          name: "diagram_graph",
          input_schema: expect.objectContaining({ type: "object" }),
        },
      ],
    });
    expect(requestOptions).toMatchObject({ signal });
  });

  it("rejects wrong or invalid tool input without echoing its contents", async () => {
    const client = fakeClient();
    client.messages.create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "diagram_graph",
          input: { value: 123, secret: "sk-secret-must-stay-private" },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = createAnthropicProvider({
      apiKey: "sk-ant-test",
      client: client as never,
    });

    const failure = await provider
      .parseStructured({
        model: "claude-sonnet-4-5",
        systemPrompt: "system",
        userPrompt: "user",
        schema: z.object({ value: z.string() }),
        schemaName: "diagram_graph",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamProviderError);
    expect((failure as Error).message).not.toContain("sk-secret");
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("propagates aborts unchanged", async () => {
    const client = fakeClient();
    const abort = new DOMException("Cancelled", "AbortError");
    client.messages.create.mockRejectedValue(abort);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant-test",
      client: client as never,
    });

    await expect(
      provider.parseStructured({
        model: "claude-sonnet-4-5",
        systemPrompt: "system",
        userPrompt: "user",
        schema: z.object({ value: z.string() }),
        schemaName: "diagram_graph",
      }),
    ).rejects.toBe(abort);
  });
});

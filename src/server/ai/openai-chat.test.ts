import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { UpstreamProviderError } from "~/server/generate/errors";
import { createOpenAIChatProvider } from "./openai-chat";
import type { GenerationProvider } from "./provider";

async function* chunks(values: unknown[]) {
  for (const value of values) {
    yield value;
  }
}

async function collect(stream: AsyncGenerator<string, void, void>) {
  const text: string[] = [];
  for await (const chunk of stream) {
    text.push(chunk);
  }
  return text;
}

function fakeClient() {
  return { chat: { completions: { create: vi.fn() } } };
}

function completion(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function request() {
  return {
    model: "local-model",
    systemPrompt: "system",
    userPrompt: "user",
    schema: z.object({ value: z.string() }),
    schemaName: "diagram_graph",
  };
}

describe("OpenAI-compatible Chat provider", () => {
  it("streams text chunks when the endpoint omits usage", async () => {
    const client = fakeClient();
    client.chat.completions.create.mockResolvedValue(
      chunks([
        { choices: [{ delta: { content: "first" } }] },
        { choices: [{ delta: { content: " second" } }] },
      ]),
    );
    const provider: GenerationProvider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });
    const signal = new AbortController().signal;
    const result = await provider.streamText({
      model: "local-model",
      systemPrompt: "system",
      userPrompt: "user",
      signal,
    });

    await expect(collect(result.stream)).resolves.toEqual(["first", " second"]);
    await expect(result.usagePromise).resolves.toBeNull();
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "local-model",
        stream: true,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
      }),
      expect.objectContaining({ signal }),
    );
    expect(
      client.chat.completions.create.mock.calls[0]?.[0],
    ).not.toHaveProperty("stream_options");
  });

  it("asks for JSON schema output and validates the response", async () => {
    const client = fakeClient();
    client.chat.completions.create.mockResolvedValue(
      completion('{"value":"ok"}'),
    );
    const provider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).resolves.toMatchObject({
      output: { value: "ok" },
      rawText: '{"value":"ok"}',
      usage: { totalTokens: 15 },
    });
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: expect.objectContaining({
            name: "diagram_graph",
            strict: true,
            schema: expect.objectContaining({ type: "object" }),
          }),
        },
      }),
      undefined,
    );
  });

  it("falls back only when schema mode is rejected, then validates and retries", async () => {
    const client = fakeClient();
    client.chat.completions.create
      .mockRejectedValueOnce(
        Object.assign(new Error("response_format json_schema unsupported"), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(completion('{"value":123}'))
      .mockResolvedValueOnce(completion('{"value":"recovered"}'));
    const provider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).resolves.toMatchObject({
      output: { value: "recovered" },
    });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(client.chat.completions.create.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_schema" },
    });
    expect(client.chat.completions.create.mock.calls[1]?.[0]).not.toMatchObject(
      {
        response_format: { type: "json_schema" },
      },
    );
    expect(
      JSON.stringify(client.chat.completions.create.mock.calls[1]?.[0]),
    ).toContain("value");
    expect(
      JSON.stringify(client.chat.completions.create.mock.calls[2]?.[0]),
    ).toContain("value");
  });

  it("falls back when Gemini rejects the schema as an invalid argument", async () => {
    // Gemini's OpenAI-compatible endpoint names no field when it refuses
    // parts of a strict JSON schema.
    const client = fakeClient();
    client.chat.completions.create
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            '400 [{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}]',
          ),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(completion('{"value":"from gemini"}'));
    const provider = createOpenAIChatProvider({
      apiKey: "gemini-key",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).resolves.toMatchObject({
      output: { value: "from gemini" },
    });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(
      client.chat.completions.create.mock.calls[1]?.[0],
    ).not.toHaveProperty("response_format");
  });

  it("gives the whole schema in prompt mode, so nested fields are known", async () => {
    const client = fakeClient();
    client.chat.completions.create
      .mockRejectedValueOnce(
        Object.assign(new Error("400 Request contains an invalid argument."), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        completion('{"nodes":[{"id":"api","shape":"box"}]}'),
      );
    const provider = createOpenAIChatProvider({
      apiKey: "gemini-key",
      client: client as never,
    });

    await expect(
      provider.parseStructured({
        ...request(),
        schema: z.object({
          nodes: z.array(
            z.object({ id: z.string(), shape: z.enum(["box", "database"]) }),
          ),
        }),
      }),
    ).resolves.toMatchObject({ output: { nodes: [{ id: "api" }] } });
    const prompt = JSON.stringify(
      client.chat.completions.create.mock.calls[1]?.[0],
    );
    expect(prompt).toContain("shape");
    expect(prompt).toContain("database");
  });

  it("reads JSON that the model wrapped in a Markdown code fence", async () => {
    const client = fakeClient();
    client.chat.completions.create
      .mockRejectedValueOnce(
        Object.assign(new Error("400 Request contains an invalid argument."), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        completion('Here it is:\n```json\n{"value":"fenced"}\n```\n'),
      );
    const provider = createOpenAIChatProvider({
      apiKey: "gemini-key",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).resolves.toMatchObject({
      output: { value: "fenced" },
    });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("tells the model what was wrong, not only where", async () => {
    const client = fakeClient();
    client.chat.completions.create
      .mockRejectedValueOnce(
        Object.assign(new Error("400 Request contains an invalid argument."), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(completion('{"value":123}'))
      .mockResolvedValueOnce(completion('{"value":"fixed"}'));
    const provider = createOpenAIChatProvider({
      apiKey: "gemini-key",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).resolves.toMatchObject({
      output: { value: "fixed" },
    });
    const retry = JSON.stringify(
      client.chat.completions.create.mock.calls[2]?.[0],
    );
    expect(retry).toMatch(/value: .*expected string/i);
  });

  it("keeps an invalid-argument failure in prompt mode from looping", async () => {
    const client = fakeClient();
    client.chat.completions.create.mockRejectedValue(
      Object.assign(new Error("400 Request contains an invalid argument."), {
        status: 400,
      }),
    );
    const provider = createOpenAIChatProvider({
      apiKey: "gemini-key",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).rejects.toBeInstanceOf(
      UpstreamProviderError,
    );
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("does not silently retry malformed output when schema mode was accepted", async () => {
    const client = fakeClient();
    client.chat.completions.create.mockResolvedValue(
      completion('{"value":123}'),
    );
    const provider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).rejects.toBeInstanceOf(
      UpstreamProviderError,
    );
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("fails after bounded retries without exposing malformed output", async () => {
    const client = fakeClient();
    client.chat.completions.create
      .mockRejectedValueOnce(
        Object.assign(new Error("response_format json_schema unsupported"), {
          status: 400,
        }),
      )
      .mockResolvedValue(
        completion('{"value":123,"secret":"sk-private-value"}'),
      );
    const provider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });

    const failure = await provider
      .parseStructured(request())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamProviderError);
    expect((failure as Error).message).not.toContain("sk-private-value");
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("keeps auth and rate-limit failures out of schema fallback", async () => {
    const client = fakeClient();
    client.chat.completions.create.mockRejectedValue(
      Object.assign(new Error("Rate limit exceeded"), { status: 429 }),
    );
    const provider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).rejects.toBeInstanceOf(
      UpstreamProviderError,
    );
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("propagates a cancelled request unchanged", async () => {
    const client = fakeClient();
    const abort = new DOMException("Cancelled", "AbortError");
    client.chat.completions.create.mockRejectedValue(abort);
    const provider = createOpenAIChatProvider({
      apiKey: "local-key",
      baseURL: "http://127.0.0.1:1234/v1",
      client: client as never,
    });

    await expect(provider.parseStructured(request())).rejects.toBe(abort);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});

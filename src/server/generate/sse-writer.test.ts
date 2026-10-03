// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagramStreamMessage } from "~/features/diagram/types";
import {
  createGenerationSseWriter,
  type GenerationStreamState,
} from "~/server/generate/sse-writer";

function createWriterHarness(highWaterMark = 1) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
    },
    { highWaterMark },
  );
  const abortController = new AbortController();
  const state: GenerationStreamState = {
    streamClosed: false,
    wasCancelled: false,
  };
  let abortCause: "client" | "deadline" | null = null;
  const abortGeneration = vi.fn((cause: "client" | "deadline") => {
    abortCause ??= cause;
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  });
  const writer = createGenerationSseWriter({
    controller: streamController,
    signal: abortController.signal,
    state,
    getAbortCause: () => abortCause,
    abortGeneration,
  });

  return {
    abort(cause: "client" | "deadline") {
      abortCause ??= cause;
      abortController.abort();
      writer.notifyPull();
    },
    abortGeneration,
    state,
    stream,
    writer,
  };
}

function message(label: string): DiagramStreamMessage {
  return { status: "started", message: label };
}

function decodeChunk(
  result: ReadableStreamReadResult<Uint8Array>,
): string | undefined {
  return result.done ? undefined : new TextDecoder().decode(result.value);
}

function createFlushHarness(flushPadBytes: number) {
  const chunks: Uint8Array[] = [];
  const state: GenerationStreamState = {
    streamClosed: false,
    wasCancelled: false,
  };
  const abortController = new AbortController();
  let abortCause: "client" | "deadline" | null = null;
  const controller = {
    desiredSize: 1,
    enqueue: vi.fn((chunk: Uint8Array) => chunks.push(chunk)),
    close: vi.fn(),
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const writer = createGenerationSseWriter({
    controller,
    signal: abortController.signal,
    state,
    getAbortCause: () => abortCause,
    abortGeneration: vi.fn(),
    flushPadBytes,
  });

  return {
    chunks,
    controller,
    state,
    writer,
    abort(cause: "client" | "deadline" = "client") {
      abortCause = cause;
      if (cause === "client") {
        state.streamClosed = true;
      }
      abortController.abort();
      writer.notifyPull();
    },
    text() {
      return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createGenerationSseWriter", () => {
  it("preserves queued write ordering", async () => {
    const harness = createWriterHarness(4);

    await expect(
      Promise.all([
        harness.writer.send(message("first")),
        harness.writer.send(message("second")),
        harness.writer.send(message("third")),
      ]),
    ).resolves.toEqual([true, true, true]);
    await harness.writer.close();

    const body = await new Response(harness.stream).text();
    expect(body).toBe(
      [
        'data: {"status":"started","message":"first"}',
        'data: {"status":"started","message":"second"}',
        'data: {"status":"started","message":"third"}',
        "",
      ].join("\n\n"),
    );
  });

  it("waits for capacity until notifyPull releases the queued write", async () => {
    const harness = createWriterHarness();
    const reader = harness.stream.getReader();

    await expect(harness.writer.send(message("first"))).resolves.toBe(true);
    let secondSettled = false;
    const secondWrite = harness.writer.send(message("second")).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    expect(decodeChunk(await reader.read())).toContain('"message":"first"');
    harness.writer.notifyPull();
    await expect(secondWrite).resolves.toBe(true);
    expect(decodeChunk(await reader.read())).toContain('"message":"second"');

    await harness.writer.close();
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    reader.releaseLock();
  });

  it("drops a queued write when cancellation aborts while backpressured", async () => {
    const harness = createWriterHarness();

    await expect(harness.writer.send(message("first"))).resolves.toBe(true);
    const cancelledWrite = harness.writer.send(message("cancelled"));
    await Promise.resolve();

    harness.abort("client");

    await expect(cancelledWrite).resolves.toBe(false);
    await harness.writer.close();
    const body = await new Response(harness.stream).text();
    expect(body).toContain('"message":"first"');
    expect(body).not.toContain('"message":"cancelled"');
  });

  it("allows only an explicitly permitted terminal write after a deadline", async () => {
    const harness = createWriterHarness();

    await expect(harness.writer.send(message("first"))).resolves.toBe(true);
    harness.abort("deadline");

    await expect(harness.writer.send(message("dropped"))).resolves.toBe(false);
    await expect(
      harness.writer.send(
        { status: "error", error: "Generation timed out." },
        { allowDeadlineTerminal: true },
      ),
    ).resolves.toBe(true);
    await harness.writer.close();

    const body = await new Response(harness.stream).text();
    expect(body).toContain('"message":"first"');
    expect(body).not.toContain('"message":"dropped"');
    expect(body).toContain('"error":"Generation timed out."');
  });

  it("marks cancellation and aborts generation when enqueue fails", async () => {
    const state: GenerationStreamState = {
      streamClosed: false,
      wasCancelled: false,
    };
    const abortController = new AbortController();
    const abortGeneration = vi.fn();
    const controller = {
      desiredSize: 1,
      enqueue: vi.fn(() => {
        throw new Error("consumer closed");
      }),
      close: vi.fn(),
      error: vi.fn(),
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    const writer = createGenerationSseWriter({
      controller,
      signal: abortController.signal,
      state,
      getAbortCause: () => null,
      abortGeneration,
    });

    await expect(writer.send(message("unwritable"))).resolves.toBe(false);

    expect(state).toEqual({ streamClosed: true, wasCancelled: true });
    expect(abortGeneration).toHaveBeenCalledWith("client");
    await writer.close();
    expect(controller.close).not.toHaveBeenCalled();
  });

  it("waits for the queued write tail before closing", async () => {
    const harness = createWriterHarness();
    const reader = harness.stream.getReader();

    await expect(harness.writer.send(message("first"))).resolves.toBe(true);
    const secondWrite = harness.writer.send(message("second"));
    let closeSettled = false;
    const close = harness.writer.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    expect(decodeChunk(await reader.read())).toContain('"message":"first"');
    harness.writer.notifyPull();
    await expect(secondWrite).resolves.toBe(true);
    await expect(close).resolves.toBeUndefined();
    expect(decodeChunk(await reader.read())).toContain('"message":"second"');
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    reader.releaseLock();
  });
});

describe("createGenerationSseWriter flushes for buffered hosts", () => {
  it("batches concurrent events within 250 ms and pads the combined batch", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(9_216);

    const first = harness.writer.send(message("first"));
    await vi.advanceTimersByTimeAsync(125);
    const second = harness.writer.send(message("second"));
    await vi.advanceTimersByTimeAsync(124);
    expect(harness.chunks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(harness.chunks).toHaveLength(1);
    expect(harness.text()).toContain('"message":"first"');
    expect(harness.text()).toContain('"message":"second"');
    expect(harness.text().indexOf('"message":"first"')).toBeLessThan(
      harness.text().indexOf('"message":"second"'),
    );
    expect(harness.text()).toMatch(/\n\n: [^\n]*\n\n$/);
    expect(harness.chunks[0]?.byteLength).toBeGreaterThanOrEqual(9_216);

    await harness.writer.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pads based on encoded bytes, including multibyte event text", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(9_216);
    const sent = harness.writer.send(message("café"));

    await vi.advanceTimersByTimeAsync(250);
    await expect(sent).resolves.toBe(true);
    expect(harness.chunks).toHaveLength(1);
    expect(harness.chunks[0]?.byteLength).toBeGreaterThanOrEqual(9_216);
    expect(harness.text()).toContain('"message":"café"');
    await harness.writer.close();
  });

  it("sends a padded comment every 15 seconds of idle time", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(9_216);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(harness.chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.chunks).toHaveLength(1);
    expect(harness.text()).toMatch(/^: [^\n]*\n\n$/);
    expect(harness.chunks[0]?.byteLength).toBeGreaterThanOrEqual(9_216);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.chunks).toHaveLength(2);
    await harness.writer.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not pad or delay writes when padding is disabled", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(0);

    await expect(harness.writer.send(message("local"))).resolves.toBe(true);
    expect(harness.chunks).toHaveLength(1);
    expect(harness.text()).toBe(
      'data: {"status":"started","message":"local"}\n\n',
    );
    await harness.writer.close();
  });

  it("flushes a pending batch before close and clears its timers", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(9_216);
    const sent = harness.writer.send(message("last"));

    await harness.writer.close();
    await expect(sent).resolves.toBe(true);
    expect(harness.text()).toContain('"message":"last"');
    expect(harness.chunks[0]?.byteLength).toBeGreaterThanOrEqual(9_216);
    expect(harness.controller.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a pending batch on cancellation without writing to a closed stream", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(9_216);
    const sent = harness.writer.send(message("cancelled"));

    harness.abort();
    await expect(sent).resolves.toBe(false);
    await harness.writer.close();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.chunks).toHaveLength(0);
    expect(harness.controller.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops pending events but sends an allowed terminal event after a deadline", async () => {
    vi.useFakeTimers();
    const harness = createFlushHarness(9_216);
    const pending = harness.writer.send(message("dropped"));

    harness.abort("deadline");
    await expect(pending).resolves.toBe(false);
    const terminal = harness.writer.send(
      { status: "error", error: "Generation timed out." },
      { allowDeadlineTerminal: true },
    );
    await harness.writer.close();

    await expect(terminal).resolves.toBe(true);
    expect(harness.text()).not.toContain('"message":"dropped"');
    expect(harness.text()).toContain('"error":"Generation timed out."');
    expect(harness.chunks[0]?.byteLength).toBeGreaterThanOrEqual(9_216);
    expect(vi.getTimerCount()).toBe(0);
  });
});

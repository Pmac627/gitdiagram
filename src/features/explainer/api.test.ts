import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchExplainerVideo,
  streamExplainerRender,
  streamExplainerVideo,
  VideoRequestError,
  VideoStreamEndedError,
} from "~/features/explainer/api";

const encoder = new TextEncoder();

/** A streamed response that sends each chunk as its own network read. */
function sse(...chunks: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explainer video streams", () => {
  it("relays CRLF-framed events and a final one sent without a blank line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          'data: {"status":"reading","elapsedMs":1}\r\n\r\n',
          'data: {"status":"error","error":"Nope."}',
        ),
      ),
    );
    const events: unknown[] = [];
    await streamExplainerVideo("acme", "tiny", (event) => events.push(event));
    expect(events).toEqual([
      { status: "reading", elapsedMs: 1 },
      { status: "error", error: "Nope." },
    ]);
  });

  // Phase 4 decision (1): replacing a video is an explicit request flag.
  describe("the regenerate flag", () => {
    const sentBody = async (
      options?: Parameters<typeof streamExplainerVideo>[4],
    ) => {
      const fetchMock = vi.fn(async () =>
        sse('data: {"status":"error","error":"Nope."}\n\n'),
      );
      vi.stubGlobal("fetch", fetchMock);
      await streamExplainerVideo(
        "acme",
        "tiny",
        () => undefined,
        undefined,
        options,
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      return { url, body: JSON.parse(init.body as string) as unknown };
    };

    it("is not sent by default", async () => {
      const { url, body } = await sentBody();

      expect(url).toBe("/api/video/generate");
      expect(body).toEqual({ username: "acme", repo: "tiny" });
    });

    it("is not sent when false", async () => {
      expect((await sentBody({ regenerate: false })).body).toEqual({
        username: "acme",
        repo: "tiny",
      });
    });

    it("is sent as true when asked for", async () => {
      expect((await sentBody({ regenerate: true })).body).toEqual({
        username: "acme",
        repo: "tiny",
        regenerate: true,
      });
    });
  });

  it("rejects a stream that closes before a complete or error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse('data: {"status":"planning","elapsedMs":1}\n\n')),
    );
    await expect(
      streamExplainerVideo("acme", "tiny", () => undefined),
    ).rejects.toBeInstanceOf(VideoStreamEndedError);
  });

  it("sends the version on screen with an MP4 request and reports a stale one", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { error: "This video was replaced.", stale: true },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = streamExplainerRender(
      "acme",
      "tiny",
      "vertical",
      "2026-09-24T00:00:00.000Z",
      () => undefined,
    );
    await expect(request).rejects.toMatchObject({
      status: 409,
      stale: true,
    });
    await expect(request).rejects.toBeInstanceOf(VideoRequestError);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      username: "acme",
      repo: "tiny",
      format: "vertical",
      v: "2026-09-24T00:00:00.000Z",
    });
  });
});

describe("fetchExplainerVideo", () => {
  it.each([
    [{ renderEnabled: true }, true],
    [{ renderEnabled: false }, false],
    [{}, false],
    [{ renderEnabled: "1" }, false],
  ])(
    "reads renderEnabled from %j as %s (missing means off)",
    async (extra, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ok: true, video: null, ...extra })),
      );
      expect(await fetchExplainerVideo("acme", "tiny")).toMatchObject({
        renderEnabled: expected,
      });
    },
  );

  it("passes on that a video is being made", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true, video: null, generating: true }),
      ),
    );
    expect(await fetchExplainerVideo("acme", "tiny")).toMatchObject({
      video: null,
      generating: true,
    });
  });
});

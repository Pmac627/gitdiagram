import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("~/server/explainer/config", () => ({
  isVideoExplainerEnabled: () => true,
}));
vi.mock("~/features/explainer/engine", () => ({ ENGINE_VERSION: "15" }));

import type { VideoArtifact } from "~/features/explainer/types";
import { writeRender, writeVideo } from "~/server/explainer/store";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

import { registerOperatorSession } from "~/server/auth/test-session";

import { GET } from "./route";

const session = registerOperatorSession();

// The route runs against the real local video store in a temp DATA_DIR. MP4s
// stream from local storage (there is no redirect to a signed URL), answer
// HTTP Range requests with 206 so a player can seek, and never let a caller
// name a path.

const v = "2026-09-24T08:06:45.297Z";
const artifact = {
  createdAt: v,
  repository: "acme/widget",
  meta: { owner: "acme", repo: "widget", stars: 1, language: "Go" },
  plan: { title: "Widget explained", beats: [{ narration: "Hi." }] },
  timing: { DURATION: 60 },
} as unknown as VideoArtifact;

// 1000 bytes where byte i is i % 251, so a wrong slice is easy to spot.
const MP4 = Buffer.from(
  Array.from({ length: 1000 }, (_, index) => index % 251),
);

let dataDir: TempDataDir;
let cwd: string;

const call = (query: Record<string, string>, headers: HeadersInit = {}) =>
  GET(
    new Request(
      `https://gitdiagram.com/api/video/file?${new URLSearchParams({
        username: "acme",
        repo: "widget",
        v,
        ...query,
      }).toString()}`,
      { headers: { ...session.headers, ...headers } },
    ),
  );

const bytes = async (response: Response) =>
  Buffer.from(await response.arrayBuffer());

beforeEach(async () => {
  dataDir = await createTempDataDir();
  cwd = await mkdtemp(path.join(tmpdir(), "video-cwd-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await writeVideo(artifact, [Buffer.from("clip")]);
  await writeRender(artifact, "landscape.mp4", MP4);
  await writeRender(artifact, "vertical.mp4", Buffer.from("vertical"));
  await writeRender(artifact, "poster.jpg", Buffer.from("jpg-poster"));
  await writeRender(artifact, "still.jpg", Buffer.from("jpg-still"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataDir.dispose();
  await rm(cwd, { recursive: true, force: true });
});

describe("GET /api/video/file: MP4 downloads", () => {
  it("streams the whole file from local storage, never redirecting", async () => {
    const response = await call({ format: "landscape" });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="acme-widget-explained.mp4"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The URL does not name the engine that drew the file: never cached.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bytes(response)).toEqual(MP4);
  });

  it("names the vertical download for its format", async () => {
    const response = await call({ format: "vertical" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "acme-widget-explained-vertical.mp4",
    );
    expect(await bytes(response)).toEqual(Buffer.from("vertical"));
  });

  it("answers 404 with JSON when the render has not been made", async () => {
    const other = await call({
      format: "landscape",
      v: "2026-09-25T00:00:00.000Z",
    });

    expect(other.status).toBe(404);
    expect(other.headers.get("content-type")).toContain("application/json");
  });

  it("answers 404 when there is no video at all", async () => {
    const response = await call({ format: "landscape", repo: "nothing" });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /api/video/file: Range requests", () => {
  it("returns 206 with the requested slice and its Content-Range", async () => {
    const response = await call(
      { format: "landscape" },
      { range: "bytes=0-99" },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await bytes(response)).toEqual(MP4.subarray(0, 100));
  });

  it("reads a slice from the middle", async () => {
    const response = await call(
      { format: "landscape" },
      { range: "bytes=250-499" },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 250-499/1000");
    expect(await bytes(response)).toEqual(MP4.subarray(250, 500));
  });

  it("reads from an offset to the end (bytes=900-)", async () => {
    const response = await call(
      { format: "landscape" },
      { range: "bytes=900-" },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(await bytes(response)).toEqual(MP4.subarray(900));
  });

  it("reads the last N bytes (bytes=-100)", async () => {
    const response = await call(
      { format: "landscape" },
      { range: "bytes=-100" },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(await bytes(response)).toEqual(MP4.subarray(900));
  });

  it("clamps an end past the file to the last byte", async () => {
    const response = await call(
      { format: "landscape" },
      { range: "bytes=990-5000" },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect(await bytes(response)).toEqual(MP4.subarray(990));
  });

  it("answers 416 with the file size when the start is past the end", async () => {
    for (const range of ["bytes=1000-1100", "bytes=5000-", "bytes=500-100"]) {
      const response = await call({ format: "landscape" }, { range });

      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range"), range).toBe("bytes */1000");
    }
  });

  it("ignores a Range header it cannot use and sends the whole file", async () => {
    // Malformed, a unit other than bytes, or several ranges at once.
    for (const range of [
      "bytes=abc",
      "bytes=",
      "items=0-10",
      "bytes=0-1,5-6",
      "bytes=--5",
    ]) {
      const response = await call({ format: "landscape" }, { range });

      expect(response.status, range).toBe(200);
      expect(response.headers.get("content-range"), range).toBeNull();
      expect(await bytes(response), range).toEqual(MP4);
    }
  });

  it("serves a single byte", async () => {
    const response = await call(
      { format: "landscape" },
      { range: "bytes=7-7" },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 7-7/1000");
    expect(response.headers.get("content-length")).toBe("1");
    expect(await bytes(response)).toEqual(MP4.subarray(7, 8));
  });
});

describe("GET /api/video/file: posters and pictures", () => {
  it("caches a poster forever only when its URL names when it was made", async () => {
    const stamped = await call({ format: "poster", p: "1790237205297" });

    expect(stamped.status).toBe(200);
    expect(stamped.headers.get("content-type")).toBe("image/jpeg");
    expect(stamped.headers.get("content-length")).toBe("10");
    expect(stamped.headers.get("cache-control")).toContain("immutable");

    const bare = await call({ format: "still" });
    expect(bare.status).toBe(200);
    expect(bare.headers.get("cache-control")).not.toContain("immutable");
  });

  it("serves the latest video's poster without a version, and nothing else", async () => {
    expect((await call({ format: "poster", v: "" })).status).toBe(400);

    const request = (format: string) =>
      GET(
        new Request(
          `https://gitdiagram.com/api/video/file?username=acme&repo=widget&format=${format}`,
          { headers: { ...session.headers } },
        ),
      );
    const poster = await request("poster");

    expect(poster.status).toBe(200);
    expect(poster.headers.get("cache-control")).not.toContain("immutable");
    expect(await bytes(poster)).toEqual(Buffer.from("jpg-poster"));
    const headerNames = [...poster.headers.keys()].map((name) =>
      name.toLowerCase(),
    );
    expect(headerNames).not.toContain("vercel-cache-tag");
    expect(headerNames).not.toContain("vercel-cdn-cache-control");
    expect(headerNames).not.toContain("cdn-cache-control");
    for (const format of ["still", "landscape", "vertical", "picture"]) {
      expect((await request(format)).status).toBe(400);
    }
  });

  it("serves a film's README picture forever, and only picture ids", async () => {
    // A JPEG header: SOI, then SOF0 (height 600, width 800).
    const jpeg = Buffer.alloc(40);
    jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 88, 3, 32]);
    await writeVideo(
      artifact,
      [Buffer.from("clip")],
      [
        { id: "img2", mediaType: "image/jpeg", bytes: jpeg },
        {
          id: "img1",
          mediaType: "image/png",
          bytes: Buffer.from("<svg onload=alert(1)>"),
        },
      ],
    );

    const found = await call({ format: "picture", id: "img2" });
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("image/jpeg");
    expect(found.headers.get("cache-control")).toContain("immutable");

    expect((await call({ format: "picture", id: "../x" })).status).toBe(400);
    // Bytes that are not a picture are never served, whatever they were stored as.
    expect((await call({ format: "picture", id: "img1" })).status).toBe(404);
    expect((await call({ format: "picture", id: "img3" })).status).toBe(404);
  });
});

describe("GET /api/video/file: cache headers", () => {
  it("never lets a shared cache keep the response (private, versioned URLs may be immutable)", async () => {
    const responses = [
      await call({ format: "landscape" }),
      await call({ format: "poster", p: "1790237205297" }),
      await call({ format: "still" }),
      await call({ format: "landscape" }, { range: "bytes=0-9" }),
    ];

    for (const response of responses) {
      const cacheControl = response.headers.get("cache-control") ?? "";

      expect(cacheControl).not.toMatch(/\bpublic\b/);
      expect(cacheControl).not.toContain("s-maxage");
    }

    expect(responses[1]!.headers.get("cache-control")).toContain("private");
  });
});

describe("GET /api/video/file: request validation", () => {
  it("rejects names and versions that could reach another path", async () => {
    const bad: Array<Record<string, string>> = [
      { format: "landscape", username: ".." },
      { format: "landscape", username: "../acme" },
      { format: "landscape", username: "acme/../.." },
      { format: "landscape", repo: ".." },
      { format: "landscape", repo: "../widget" },
      { format: "landscape", repo: "a/b" },
      { format: "landscape", repo: String.raw`a\b` },
      { format: "landscape", v: "../../etc/passwd" },
      { format: "../../landscape" },
      { format: "landscape.mp4" },
    ];

    for (const query of bad) {
      const response = await call(query);

      expect(response.status, JSON.stringify(query)).toBe(400);
    }
  });
});

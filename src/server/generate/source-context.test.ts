import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubData } from "./github";
import { fetchSourceContext } from "./source-context";
import {
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_FILE_BYTES,
} from "./repository-context";
vi.mock("../github-auth", () => ({
  getGitHubApiHeaders: async ({ githubPat }: { githubPat?: string }) => ({
    Authorization: `Bearer ${githubPat ?? "public-server-token"}`,
  }),
}));
afterEach(() => vi.unstubAllGlobals());
const source = "export const main = 1;";
const blobHash = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
function repo(paths = ["src/main.ts"], text = source): GithubData {
  return {
    defaultBranch: "main",
    fileTree: paths.join("\n"),
    readme: "",
    isPrivate: false,
    stargazerCount: 0,
    pathTypes: new Map(paths.map((p) => [p, "blob"])),
    sourceBlobs: new Map(
      paths.map((p) => [
        p,
        { sha: blobHash(text), size: Buffer.byteLength(text) },
      ]),
    ),
  };
}
const body = (text: string) =>
  new Response(
    JSON.stringify({
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
      size: Buffer.byteLength(text),
    }),
  );

describe("bounded source ingestion", () => {
  it("fetches only verified blobs and never follows symlinks, arbitrary paths or redirects", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) =>
      body("export const main = 1;"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: { ...repo(), isPrivate: true },
      githubPat: "private-caller-token",
      selectedPaths: ["src/main.ts", "src/symlink.ts", ".env"],
    });
    expect(result.paths).toEqual(["src/main.ts"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/owner/repo/git/blobs/${blobHash(source)}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer private-caller-token" },
    });
  });
  it("rejects private reads without caller authorization before any fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchSourceContext({
        username: "owner",
        repo: "repo",
        githubData: { ...repo(), isPrivate: true },
        selectedPaths: ["src/main.ts"],
      }),
    ).rejects.toThrow("GitHub token");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("degrades unavailable or binary source to an explicit coverage limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response("\0binary")),
    );
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: repo(["a.ts", "b.ts"]),
      selectedPaths: ["a.ts", "b.ts"],
    });
    expect(result.paths).toEqual([]);
    expect(result.unavailableCount).toBe(2);
    expect(result.text).toContain("No source excerpts");
  });
  it("bounds total excerpts and rejects an oversized streamed response", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("source\n".repeat(12000))),
    );
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: repo(paths, "source\n".repeat(12000)),
      selectedPaths: paths,
    });
    expect(result.paths).toHaveLength(12);
    expect(result.text.length).toBeLessThanOrEqual(MAX_SOURCE_CHARACTERS);
    expect(result.text).toContain("gaps omitted");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(MAX_SOURCE_FILE_BYTES + 1))),
    );
    const oversized = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: repo(),
      selectedPaths: ["src/main.ts"],
    });
    expect(oversized.paths).toEqual([]);
  });
  it("propagates caller cancellation instead of silently falling back", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort(new Error("cancelled"));
        throw controller.signal.reason;
      }),
    );
    await expect(
      fetchSourceContext({
        username: "owner",
        repo: "repo",
        githubData: repo(),
        selectedPaths: ["src/main.ts"],
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
  it("reads public sources without sending caller or server credentials", async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init: RequestInit) => new Response(source),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: { ...repo(), usedPublicFallback: true },
      selectedPaths: ["src/main.ts"],
      githubPat: "expired-token",
    });
    expect(result.paths).toEqual(["src/main.ts"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/src/main.ts",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("rejects changed or malformed public content instead of mixing file versions", async () => {
    for (const bytes of [
      new TextEncoder().encode("different branch content"),
      new Uint8Array([0xc3, 0x28]),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(bytes)),
      );
      const result = await fetchSourceContext({
        username: "owner",
        repo: "repo",
        githubData: repo(),
        selectedPaths: ["src/main.ts"],
      });
      expect(result.paths).toEqual([]);
      expect(result.unavailableCount).toBe(1);
    }
  });
  it("encodes branch and file names on public content URLs", async () => {
    const fetchMock = vi.fn(async () => new Response(source));
    vi.stubGlobal("fetch", fetchMock);
    const path = "src/a file.ts";
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: { ...repo([path]), defaultBranch: "release/v2" },
      selectedPaths: [path],
    });
    expect(result.paths).toEqual([path]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/repo/release%2Fv2/src/a%20file.ts",
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it("recovers immutable source after a branch move without leaking credentials to the CDN", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://raw.")
        ? new Response("new branch content")
        : body(source),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: repo(),
      selectedPaths: ["src/main.ts"],
    });
    expect(result.paths).toEqual(["src/main.ts"]);
    expect(result.text).toContain(source);
    expect(result.text).not.toContain("new branch content");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner/repo/git/blobs/${blobHash(source)}`,
      expect.objectContaining({
        redirect: "error",
        headers: { Authorization: "Bearer public-server-token" },
      }),
    );
  });
  it("bounds branch-move recovery to two immutable blob requests", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://raw.") ? new Response("changed") : body(source),
    );
    vi.stubGlobal("fetch", fetchMock);
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: repo(paths),
      selectedPaths: paths,
    });
    expect(result.paths).toHaveLength(2);
    expect(result.unavailableCount).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url.startsWith("https://api."))
        .length,
    ).toBe(2);
  });
});

describe("secret redaction in source excerpts", () => {
  const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const keyBody = [
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
    "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
  ];
  const keyBlock = `-----BEGIN PRIVATE KEY-----\n${keyBody.join("\n")}\n-----END PRIVATE KEY-----`;

  function perPathRepo(files: Record<string, string>, isPrivate = false) {
    const paths = Object.keys(files);

    return {
      defaultBranch: "main",
      fileTree: paths.join("\n"),
      readme: "",
      isPrivate,
      stargazerCount: 0,
      pathTypes: new Map(paths.map((p) => [p, "blob"])),
      sourceBlobs: new Map(
        paths.map((p) => [
          p,
          { sha: blobHash(files[p]!), size: Buffer.byteLength(files[p]!) },
        ]),
      ),
    } satisfies GithubData;
  }

  function stubPublicFetch(files: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const path = Object.keys(files).find((p) => String(input).endsWith(p));

        return new Response(path ? files[path]! : "", {
          status: path ? 200 : 404,
        });
      }),
    );
  }

  it("redacts secrets in a public file before it enters the source text", async () => {
    const files = {
      "src/config.ts": `export const key = "${AWS_KEY}";\nexport const main = 1;\n`,
    };
    stubPublicFetch(files);

    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: perPathRepo(files),
      selectedPaths: ["src/config.ts"],
    });

    expect(result.text).not.toContain(AWS_KEY);
    expect(result.text).toContain("[REDACTED:aws-access-key]");
    expect(result.text).toContain("export const main = 1;");
    expect(result.redactedSecretCount).toBe(1);
  });

  it("redacts secrets in a private file read through the blob API", async () => {
    const text = `export const key = "${AWS_KEY}";\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => body(text)),
    );

    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: perPathRepo({ "src/config.ts": text }, true),
      githubPat: "private-caller-token",
      selectedPaths: ["src/config.ts"],
    });

    expect(result.text).not.toContain(AWS_KEY);
    expect(result.redactedSecretCount).toBe(1);
  });

  it("scans the whole file before excerpting, so a key block never leaks through a window", async () => {
    const filler = "const value = compute(input, options);\n".repeat(400);
    const text = `${filler}${keyBlock}\n${filler}`;
    expect(text.length).toBeGreaterThan(10_000);
    const files = { "src/big.ts": text };
    stubPublicFetch(files);

    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: perPathRepo(files),
      selectedPaths: ["src/big.ts"],
    });

    expect(result.text).toContain("(partial excerpt)");
    for (const line of keyBody) {
      expect(result.text).not.toContain(line);
    }
    expect(result.text).not.toContain("PRIVATE KEY");
    expect(result.redactedSecretCount).toBe(1);
  });

  it("sums findings across files and reports zero for clean sources", async () => {
    const files = {
      "src/a.ts": `export const a = "${AWS_KEY}";\n`,
      "src/b.ts": `export const b = "${AWS_KEY}";\nexport const c = "${AWS_KEY}";\n`,
      "src/c.ts": "export const clean = 1;\n",
    };
    stubPublicFetch(files);

    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: perPathRepo(files),
      selectedPaths: Object.keys(files),
    });

    expect(result.redactedSecretCount).toBe(3);
    expect(result.text).not.toContain(AWS_KEY);

    stubPublicFetch({ "src/main.ts": source });
    const clean = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: repo(),
      selectedPaths: ["src/main.ts"],
    });

    expect(clean.redactedSecretCount).toBe(0);
  });

  it("reports zero redactions when no source is available", async () => {
    const result = await fetchSourceContext({
      username: "owner",
      repo: "repo",
      githubData: { ...repo(), sourceBlobs: new Map() },
      selectedPaths: ["src/main.ts"],
    });

    expect(result.redactedSecretCount).toBe(0);
  });
});
